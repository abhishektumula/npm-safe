// Hand-rolled ANSI colors. Zero dependencies, no bold/italic per spec —
// color only, so output stays clean in JetBrainsMono / GeistMono Nerd Fonts.
const ESC = "\x1b[";

export const c = {
  reset: `${ESC}0m`,
  dim: `${ESC}90m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  blue: `${ESC}34m`,
  magenta: `${ESC}35m`,
  cyan: `${ESC}36m`,
  white: `${ESC}37m`,
  orange: `${ESC}38;5;208m`,
  pink: `${ESC}38;5;205m`,
  lime: `${ESC}38;5;118m`,
  violet: `${ESC}38;5;141m`,
  teal: `${ESC}38;5;80m`,
};

export function paint(color: string, text: string): string {
  return `${color}${text}${c.reset}`;
}

export function healthColor(score: number): string {
  if (score >= 80) return c.green;
  if (score >= 60) return c.lime;
  if (score >= 40) return c.yellow;
  if (score >= 20) return c.orange;
  return c.red;
}

function block(pct: number): string {
  const filled = Math.round((pct / 100) * 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

export function healthBar(score: number): string {
  return paint(healthColor(score), block(score));
}
