import { Readable, Writable } from "node:stream";
import { describe, expect, test } from "bun:test";
import { confirm, parseConfirmAnswer } from "../src/prompt.ts";

describe("parseConfirmAnswer", () => {
  test.each(["y", "Y", "yes", "YES", "Yes", "  y  ", "\tyes\n"])("confirms %j", (line) => {
    expect(parseConfirmAnswer(line)).toBe(true);
  });
  test.each(["", "n", "N", "no", "yep", "ye", "yess", "1"])("aborts %j", (line) => {
    expect(parseConfirmAnswer(line)).toBe(false);
  });
});

describe("confirm", () => {
  test("returns false when input is not a TTY", async () => {
    const input = new Readable({ read() {} });
    (input as any).isTTY = false;
    expect(await confirm(input)).toBe(false);
  });

  test("confirms when user inputs y on a TTY", async () => {
    const input = new Readable({
      read() {
        this.push("y\n");
        this.push(null);
      },
    });
    (input as any).isTTY = true;
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    expect(await confirm(input, output)).toBe(true);
  });

  test("aborts when user inputs n on a TTY", async () => {
    const input = new Readable({
      read() {
        this.push("n\n");
        this.push(null);
      },
    });
    (input as any).isTTY = true;
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    expect(await confirm(input, output)).toBe(false);
  });
});

describe("confirm single-keypress (raw mode)", () => {
  const ESC = String.fromCharCode(27);

  function rawInput() {
    const input = new Readable({ read() {} });
    (input as any).isTTY = true;
    const modes: boolean[] = [];
    (input as any).setRawMode = (mode: boolean) => {
      modes.push(mode);
    };
    const chunks: string[] = [];
    const output = new Writable({
      write(chunk: unknown, _encoding: string, callback: () => void) {
        chunks.push(String(chunk));
        callback();
      },
    });
    return { input, output, modes, chunks };
  }

  test("y resolves true without Enter and restores the terminal", async () => {
    const { input, output, modes, chunks } = rawInput();
    const pending = confirm(input, output);
    input.emit("data", Buffer.from("y"));
    await expect(pending).resolves.toBe(true);
    expect(modes).toEqual([true, false]);
    expect(chunks.join("")).toContain("y\n");
  });

  test("N resolves false", async () => {
    const { input, output } = rawInput();
    const pending = confirm(input, output);
    input.emit("data", Buffer.from("N"));
    await expect(pending).resolves.toBe(false);
  });

  test("Enter aborts (default N)", async () => {
    const { input, output } = rawInput();
    const pending = confirm(input, output);
    input.emit("data", Buffer.from("\r"));
    await expect(pending).resolves.toBe(false);
  });

  test("Escape aborts", async () => {
    const { input, output } = rawInput();
    const pending = confirm(input, output);
    input.emit("data", Buffer.from(ESC));
    await expect(pending).resolves.toBe(false);
  });

  test("other keys are ignored until y/n", async () => {
    const { input, output, chunks } = rawInput();
    const pending = confirm(input, output);
    input.emit("data", Buffer.from("x"));
    input.emit("data", Buffer.from("?"));
    input.emit("data", Buffer.from("Y"));
    await expect(pending).resolves.toBe(true);
    expect(chunks.join("")).not.toContain("x");
  });
});
