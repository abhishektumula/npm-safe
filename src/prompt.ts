// Confirm prompt. Single keypress (`y` / `n`, no Enter) via raw mode;
// falls back to node:readline where raw mode is unavailable. No `Bun.*`
// APIs — runs under Node ≥18 and Bun. The answer parser is pure for tests.
import { createInterface } from "node:readline";
import { c, paint } from "./colors.ts";

export interface ConfirmInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
}

/** "y" / "yes" (any case, padded) confirm; everything else aborts. */
export function parseConfirmAnswer(line: string): boolean {
  const a = line.trim().toLowerCase();
  return a === "y" || a === "yes";
}

export async function confirm(
  input: ConfirmInput = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<boolean> {
  if (!input.isTTY) return false;
  const prompt = paint(c.yellow, "\n  install these packages? [y/N] ");
  if (typeof input.setRawMode === "function") return rawKeyConfirm(input, output, prompt);
  const rl = createInterface({ input, output });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(prompt, resolve);
    });
    return parseConfirmAnswer(answer);
  } finally {
    rl.close();
  }
}

// Control keys are written as \x escapes on purpose: the bytes this
// branch matches on (ESC, ETX) are invisible in an editor.
const ESC = "\x1b";
const ETX = "\x03";

/**
 * Resolve on the first keypress: y/Y confirms, n/N/Enter/Escape aborts,
 * anything else is ignored. Ctrl-C restores the terminal and re-raises
 * SIGINT so it still terminates the process as usual.
 */
function rawKeyConfirm(
  input: ConfirmInput,
  output: NodeJS.WritableStream,
  prompt: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    output.write(prompt);
    const cleanup = () => {
      input.removeListener("data", onData);
      try {
        input.setRawMode?.(false);
      } catch {
        /* already restored */
      }
      if (typeof input.pause === "function") input.pause();
    };
    const done = (value: boolean, echo: string) => {
      cleanup();
      output.write(`${echo}\n`);
      resolve(value);
    };
    const onData = (chunk: unknown) => {
      const key = String(chunk)[0] ?? "";
      if (key === "y" || key === "Y") done(true, key);
      else if (key === "n" || key === "N" || key === "\r" || key === "\n") done(false, key);
      else if (key === ESC) done(false, "");
      else if (key === ETX) {
        cleanup();
        process.kill(process.pid, "SIGINT");
      }
      // Any other key is ignored — keep waiting for y/n.
    };
    input.setRawMode?.(true);
    input.resume();
    input.on("data", onData);
  });
}
