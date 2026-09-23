import { describe, expect, test } from "bun:test";
import {
  SPINNER_FRAMES,
  spinnerFrame,
  spinnerLine,
  startSpinner,
} from "../src/spinner.ts";
import { c } from "../src/colors.ts";
import { stripAnsi } from "./helper.ts";

function fakeStream(isTTY = false): { stream: NodeJS.WriteStream; writes: string[] } {
  const writes: string[] = [];
  const stream = {
    isTTY,
    write: (s: string) => {
      writes.push(String(s));
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { stream, writes };
}

function text(writes: string[]): string {
  return stripAnsi(writes.join(""));
}

describe("spinnerFrame", () => {
  test("cycles the dots, wraps around", () => {
    expect(SPINNER_FRAMES.length).toBeGreaterThan(1);
    expect(text([spinnerFrame(0)])).toContain(SPINNER_FRAMES[0]!);
    expect(text([spinnerFrame(SPINNER_FRAMES.length)])).toContain(SPINNER_FRAMES[0]!);
    expect(text([spinnerFrame(SPINNER_FRAMES.length)])).toBe(text([spinnerFrame(0)]));
    expect(text([spinnerFrame(1)])).not.toBe(text([spinnerFrame(0)]));
  });
  test("handles negative ticks", () => {
    expect(text([spinnerFrame(-1)])).toContain(SPINNER_FRAMES[SPINNER_FRAMES.length - 1]!);
  });
});

describe("spinnerLine", () => {
  test("carries frame and label", () => {
    const line = text([spinnerLine("⠋", "fetching intel")]);
    expect(line).toContain("⠋");
    expect(line).toContain("fetching intel");
  });
  test("label uses no dim grey (readability)", () => {
    expect(spinnerLine("⠋", "fetching intel")).not.toContain(c.dim);
  });
});

describe("startSpinner (static fallback)", () => {
  test("writes one static line when disabled", () => {
    const { stream, writes } = fakeStream(false);
    const s = startSpinner("fetching intel for x", { stream, enabled: false });
    expect(text(writes)).toContain("fetching intel for x");
    s.stop();
    expect(writes.length).toBe(1);
  });
  test("succeed writes a check line", () => {
    const { stream, writes } = fakeStream(false);
    const s = startSpinner("working", { stream, enabled: false });
    s.succeed("installed x via npm");
    expect(text(writes)).toContain("installed x via npm");
    expect(text(writes)).toContain("✔");
  });
  test("succeed defaults to the label", () => {
    const { stream, writes } = fakeStream(false);
    const s = startSpinner("working", { stream, enabled: false });
    s.succeed();
    expect(text(writes)).toContain("working");
  });
  test("fail writes a cross line", () => {
    const { stream, writes } = fakeStream(false);
    const s = startSpinner("working", { stream, enabled: false });
    s.fail("npm resolve failed: nope");
    expect(text(writes)).toContain("✖");
    expect(text(writes)).toContain("npm resolve failed: nope");
  });
  test("second finish is a no-op", () => {
    const { stream, writes } = fakeStream(false);
    const s = startSpinner("working", { stream, enabled: false });
    s.succeed("done");
    s.fail("late");
    s.stop();
    expect(writes.length).toBe(2);
  });
  test("non-TTY stream defaults to static", () => {
    const { stream, writes } = fakeStream(false);
    const s = startSpinner("working", { stream });
    s.stop();
    expect(text(writes)).toContain("working");
  });
  test("TERM=dumb defaults to static even on a TTY", () => {
    const prev = process.env.TERM;
    process.env.TERM = "dumb";
    try {
      const { stream, writes } = fakeStream(true);
      const s = startSpinner("working", { stream });
      s.stop();
      expect(text(writes)).toContain("working");
    } finally {
      if (prev === undefined) delete process.env.TERM;
      else process.env.TERM = prev;
    }
  });
});

describe("startSpinner (animated)", () => {
  test("renders, updates, and succeeds on one line", () => {
    const { stream, writes } = fakeStream(true);
    const s = startSpinner("fetching intel", { stream, enabled: true, intervalMs: 60_000 });
    try {
      expect(text(writes)).toContain("fetching intel");
      s.update("still fetching");
      expect(text(writes)).toContain("still fetching");
      s.succeed("done");
      expect(text(writes)).toContain("✔");
      expect(text(writes)).toContain("done");
    } finally {
      s.stop();
    }
  });
  test("fail and stop clear the line", () => {
    const { stream, writes } = fakeStream(true);
    const s = startSpinner("working", { stream, enabled: true, intervalMs: 60_000 });
    s.fail("boom");
    expect(text(writes)).toContain("✖");
    const s2 = startSpinner("working", { stream, enabled: true, intervalMs: 60_000 });
    s2.stop();
    expect(writes.length).toBeGreaterThan(0);
  });
  test("ticks advance the dots while running", async () => {
    const { stream, writes } = fakeStream(true);
    const s = startSpinner("working", { stream, enabled: true, intervalMs: 10 });
    try {
      const before = writes.length;
      await new Promise((r) => setTimeout(r, 50));
      expect(writes.length).toBeGreaterThan(before);
    } finally {
      s.stop();
    }
  });
});
