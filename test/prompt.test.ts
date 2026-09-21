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
    const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
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
    const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    expect(await confirm(input, output)).toBe(false);
  });
});
