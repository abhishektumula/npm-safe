// Shared fetch for the intel pipeline (registry, Snyk, transitive BFS).
//
// The BFS in deps.ts fans out at CONCURRENCY 20; a burst that trips a
// 429/503 should back off and retry instead of failing the whole screen.
// Transient failures are retried: 429, gateway errors (502/503/504), and
// network errors/timeouts (a dropped socket or one slow CDN edge should not
// blank a card). 404/500 mean what they say and flow to the callers'
// existing error paths. Each attempt gets its own timeout signal
// so a slow first attempt can't eat the next attempt's budget. Honors
// Retry-After (capped); uses globalThis.fetch so tests keep stubbing one
// seam. Pure orchestration — no runtime APIs beyond fetch/timers.

export interface FetchRetryOptions {
  /** per-attempt timeout in ms (default 8000) */
  timeoutMs?: number;
  /** total attempts including the first (default 2) */
  maxAttempts?: number;
  /** cap for a Retry-After delay in ms (default 5000) */
  maxBackoffMs?: number;
  /** fallback delay when the server sends no usable Retry-After (default 500) */
  defaultBackoffMs?: number;
}

/** Statuses worth a second attempt: rate limits and gateway hiccups. */
const RETRY_STATUS = new Set([429, 502, 503, 504]);

function backoffMs(res: Response, opts: Required<FetchRetryOptions>): number {
  const raw = res.headers?.get?.("retry-after") ?? null;
  const secs = raw !== null ? Number(raw) : NaN;
  const base = Number.isFinite(secs) && secs >= 0 ? secs * 1000 : opts.defaultBackoffMs;
  return Math.min(Math.max(0, base), opts.maxBackoffMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithRetry(
  url: string,
  init: { headers?: Record<string, string>; method?: string; body?: string } = {},
  options: FetchRetryOptions = {},
): Promise<Response> {
  const opts: Required<FetchRetryOptions> = {
    timeoutMs: options.timeoutMs ?? 8000,
    maxAttempts: Math.max(1, options.maxAttempts ?? 2),
    maxBackoffMs: options.maxBackoffMs ?? 5000,
    defaultBackoffMs: options.defaultBackoffMs ?? 500,
  };
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: init.headers,
        ...(init.method ? { method: init.method } : {}),
        ...(init.body !== undefined ? { body: init.body } : {}),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (err) {
      lastError = err;
      // Bounded by maxAttempts; callers still degrade gracefully after that.
      if (attempt < opts.maxAttempts) await sleep(opts.defaultBackoffMs);
      continue;
    }
    if (RETRY_STATUS.has(res.status) && attempt < opts.maxAttempts) {
      // Drain so the socket can be reused; tolerate stub-shaped responses.
      try {
        await res.arrayBuffer?.();
      } catch {
        /* ignore drain failures */
      }
      await sleep(backoffMs(res, opts));
      continue;
    }
    return res;
  }
  throw lastError instanceof Error ? lastError : new Error("fetch failed");
}
