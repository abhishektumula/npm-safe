// Animated orb spinner for long waits (intel fetch, installs).
// While TTY-attached the orb tumbles through shapes + colors on one line
// (`\r` rewrite); otherwise a static line is printed once so CI/logs stay
// readable. No `Bun.*` APIs — runs under Node ≥18 and Bun. Frame helpers
// are pure for tests; the interval driver is thin by design.
import { c, paint } from "./colors.ts";

/** Orb phases, one per tick — the shape appears to tumble. */
export const ORB_FRAMES = ["◐", "◓", "◑", "◒"];

/** Color cycle, one step per tick — the orb drifts through the palette. */
export const ORB_COLORS = [c.pink, c.cyan, c.violet, c.teal, c.lime];

export const SPINNER_INTERVAL_MS = 80;

/** Painted orb for tick `t` (shape and color both advance). Pure for tests. */
export function orbFrame(tick: number): string {
  const frame =
    ORB_FRAMES[((tick % ORB_FRAMES.length) + ORB_FRAMES.length) % ORB_FRAMES.length]!;
  const color =
    ORB_COLORS[((tick % ORB_COLORS.length) + ORB_COLORS.length) % ORB_COLORS.length]!;
  return paint(color, frame);
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
    stream.write(`\r\x1b[K${spinnerLine(orbFrame(tick), text)}`);
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
