// Confirm prompt. node:readline works in Node and Bun — Bun's
// `for await (console)` iterator does not exist in Node, so `Bun.*`
// APIs are never touched here. The answer parser is pure for tests.
import { createInterface } from "node:readline";
import { c, paint } from "./colors.ts";

/** "y" / "yes" (any case, padded) confirm; everything else aborts. */
export function parseConfirmAnswer(line: string): boolean {
  const a = line.trim().toLowerCase();
  return a === "y" || a === "yes";
}

export async function confirm(
  input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<boolean> {
  if (!input.isTTY) return false;
  const rl = createInterface({ input, output });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(paint(c.yellow, "\n  install these packages? [y/N] "), resolve);
    });
    return parseConfirmAnswer(answer);
  } finally {
    rl.close();
  }
}
