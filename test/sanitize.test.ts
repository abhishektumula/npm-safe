import { describe, expect, test } from "bun:test";
import { sanitizeTerminal } from "../src/sanitize.ts";

describe("sanitizeTerminal", () => {
  test("strips CSI sequences (cursor moves, screen clears, colors)", () => {
    expect(sanitizeTerminal("a\x1b[2Jb")).toBe("ab");
    expect(sanitizeTerminal("a\x1b[1Amove\x1b[2Kerased")).toBe("amoveerased");
    expect(sanitizeTerminal("\x1b[32mgreen\x1b[0m")).toBe("green");
  });
  test("strips OSC payloads whole (clipboard writes, hyperlinks, titles)", () => {
    expect(sanitizeTerminal("a\x1b]52;c;H4sIAAAAAAAAA\x07b")).toBe("ab");
    expect(sanitizeTerminal("a\x1b]8;;https://evil.example\x1b\\bad link\x1b]8;;\x1b\\c")).toBe(
      "abad linkc",
    );
  });
  test("strips C0 controls, DEL, and C1 bytes", () => {
    expect(sanitizeTerminal("a\x00b\x07c\x1bd")).toBe("abcd");
    expect(sanitizeTerminal("a\x7fb")).toBe("ab");
    expect(sanitizeTerminal("a\x9db")).toBe("ab");
  });
  test("strips bidi overrides and separators", () => {
    expect(sanitizeTerminal("readme-\u202edm.md")).toBe("readme-dm.md");
    expect(sanitizeTerminal("a\u2028b")).toBe("ab");
  });
  test("drops bare carriage returns but keeps CRLF", () => {
    expect(sanitizeTerminal("a\rb")).toBe("ab");
    expect(sanitizeTerminal("a\r\nb")).toBe("a\r\nb");
  });
  test("keeps plain text, newlines, tabs, and emoji", () => {
    expect(sanitizeTerminal("Fast web framework\nfor node\t📦")).toBe(
      "Fast web framework\nfor node\t📦",
    );
  });
  test("is idempotent", () => {
    const once = sanitizeTerminal("a\x1b[2Jb\x1b]0;title\x07c");
    expect(sanitizeTerminal(once)).toBe(once);
  });
});
