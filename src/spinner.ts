// Animated spinner for long waits (intel fetch, installs).
// Same look as the default spinner in ora and most CLIs: braille dots
// cycling on one line (`\r` rewrite) in cyan. Non-TTY / `TERM=dumb`
// falls back to a static line so CI/logs stay readable. No `Bun.*`
// APIs — runs under Node ≥18 and Bun. Frame helpers are pure for
// tests; the interval driver is thin by design.
import { c, paint } from "./colors.ts";

/** Braille dots, one per tick — the cli-spinners "dots" set (ora's default). */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠚", "⠞", "⠖", "⠦", "⠴", "⠲", "⠳", "⠓"];

export const SPINNER_INTERVAL_MS = 80;

/** Painted dots frame for tick `t`. Pure for tests. */
export function spinnerFrame(tick: number): string {
  const frame =
    SPINNER_FRAMES[((tick % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length]!;
  return paint(c.cyan, frame);
}

/** Full spinner line for a raw frame + label. Pure for tests. */
export function spinnerLine(frame: string, label: string): string {
  return `  ${frame} ${paint(c.dim, label)}`;
}

export interface SpinnerOptions {
  stream?: NodeJS.WriteStream;
  intervalMs?: number;
  /** Force on/off (default: on only when the stream is a TTY). */
  enabled?: boolean;
}

export interface Spinner {
  update(label: string): void;
  succeed(text?: string): void;
  fail(text?: string): void;
  stop(): void;
}

function isAnimated(stream: NodeJS.WriteStream | undefined, enabled: boolean | undefined): boolean {
  if (enabled !== undefined) return enabled;
  if (!stream || stream.isTTY !== true) return false;
  if (process.env.TERM === "dumb") return false;
  return true;
}

export function startSpinner(label: string, opts: SpinnerOptions = {}): Spinner {
  const stream = opts.stream ?? process.stdout;
  const intervalMs = opts.intervalMs ?? SPINNER_INTERVAL_MS;
  const animated = isAnimated(stream, opts.enabled);
  let text = label;
  let tick = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let settled = false;

  const render = (): void => {
    stream.write(`\r\x1b[K${spinnerLine(spinnerFrame(tick), text)}`);
  };
  const clear = (): void => {
    if (animated) stream.write("\r\x1b[K");
  };

  if (!animated) {
    stream.write(paint(c.dim, `  ◌ ${text} …\n`));
  } else {
    render();
    timer = setInterval(() => {
      tick++;
      render();
    }, intervalMs);
    const t = timer as unknown as { unref?: () => void };
    if (typeof t.unref === "function") t.unref();
  }

  const finish = (line: string | null): void => {
    if (settled) return;
    settled = true;
    if (timer) clearInterval(timer);
    timer = null;
    if (line !== null) {
      clear();
      stream.write(`${line}\n`);
    } else {
      clear();
    }
  };

  return {
    update(next: string): void {
      text = next;
      if (animated && !settled) render();
    },
    succeed(doneText?: string): void {
      finish(paint(c.green, `  ✔ ${doneText ?? text}`));
    },
    fail(errText?: string): void {
      finish(paint(c.red, `  ✖ ${errText ?? text}`));
    },
    stop(): void {
      if (!animated) {
        settled = true;
        return;
      }
      finish(null);
    },
  };
}
