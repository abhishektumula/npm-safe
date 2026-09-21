import { describe, expect, test } from "bun:test";
import { parseConfirmAnswer } from "../src/prompt.ts";

describe("parseConfirmAnswer", () => {
  test.each(["y", "Y", "yes", "YES", "Yes", "  y  ", "\tyes\n"])("confirms %j", (line) => {
    expect(parseConfirmAnswer(line)).toBe(true);
  });
  test.each(["", "n", "N", "no", "yep", "ye", "yess", "1"])("aborts %j", (line) => {
    expect(parseConfirmAnswer(line)).toBe(false);
  });
});
