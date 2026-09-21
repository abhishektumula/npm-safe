import { describe, expect, test } from "bun:test";
import { c, healthBar, healthColor, paint } from "../src/colors.ts";

describe("healthColor", () => {
  test.each([
    [100, c.green],
    [80, c.green],
    [79, c.lime],
    [60, c.lime],
    [59, c.yellow],
    [40, c.yellow],
    [39, c.orange],
    [20, c.orange],
    [19, c.red],
    [0, c.red],
  ])("score %i maps correctly", (score, color) => {
    expect(healthColor(score)).toBe(color);
  });
});

describe("healthBar", () => {
  test("100 is full, 0 is empty, width is 10", () => {
    expect(healthBar(100)).toContain("█".repeat(10));
    expect(healthBar(0)).toContain("░".repeat(10));
    const mid = healthBar(50);
    expect(mid).toContain("█".repeat(5) + "░".repeat(5));
  });
});

describe("paint", () => {
  test("wraps text and resets", () => {
    expect(paint(c.red, "x")).toBe(`${c.red}x${c.reset}`);
  });
});
