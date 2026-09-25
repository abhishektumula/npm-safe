import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import { stripAnsi } from "./helper.ts";
import { clearIntelCache } from "../src/cache.ts";
import { clearNpmInflight } from "../src/npm.ts";
import { clearHealthInflight } from "../src/snyk.ts";
import { clearDepsCache } from "../src/deps.ts";
import { clearPmConfigCache } from "../src/pmconfig.ts";

const realFetch = globalThis.fetch;
const realLog = console.log;
const realError = console.error;

let logs: string[];
let errors: string[];

beforeEach(() => {
  logs = [];
  errors = [];
  process.exitCode = 0;
  clearIntelCache();
  clearNpmInflight();
  clearHealthInflight();
  clearDepsCache();
  clearPmConfigCache();
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.log = realLog;
  console.error = realError;
  // Reset to 0, not undefined: bun latches a nonzero exitCode for the
  // whole run even if a later test clears it to undefined.
  process.exitCode = 0;
  globalThis.fetch = realFetch;
});

const HEALTH_HTML = `<span class="score-number">80/100</span>`;

/** Registry returns a bare meta doc; everything else 404s. */
function stubRegistry(metaNames: string[] = ["pkgr1"]) {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("security.snyk.io")) {
      return { status: 200, ok: true, text: async () => HEALTH_HTML };
    }
    const name = u.split("/").at(-2) ?? "";
    if (!metaNames.includes(name)) {
      return { status: 404, ok: false, json: async () => ({}) };
    }
    return {
      status: 200,
      ok: true,
      json: async () => ({
        name,
        version: "1.0.0",
        description: `${name} package`,
        author: "tester",
        license: "MIT",
        repository: "https://github.com/test/test",
        dependencies: {},
        maintainers: [],
      }),
    };
  }) as unknown as typeof fetch;
}

function output(): string {
  return stripAnsi([...logs, ...errors].join("\n"));
}

describe("run", () => {
  test("version flag prints and exits clean", async () => {
    await run(["-v"]);
    expect(output()).toContain("0.1.2");
    expect(process.exitCode).toBe(0);
  });
  test("no packages does project install (dry-run)", async () => {
    await run(["--dry-run"]);
    expect(output()).toContain("would run `bun install`");
    expect(process.exitCode).toBe(0);
  });
  test("passthrough dry-run never spawns", async () => {
    await run(["run", "--dry-run", "build"]);
    expect(output()).toContain("dry-run");
    expect(process.exitCode).toBe(0);
  });
  test("install dry-run shows intel then the plan", async () => {
    stubRegistry();
    await run(["add", "pkgr1", "--dry-run", "--pm", "bun"]);
    const out = output();
    expect(out).toContain("pkgr1");
    expect(out).toContain("dry-run");
    expect(process.exitCode).toBe(0);
  });
  test("--json emits a parseable report", async () => {
    stubRegistry();
    await run(["add", "pkgr1", "--json", "--dry-run", "--pm", "bun"]);
    const parsed = JSON.parse(stripAnsi(logs[0] ?? "")) as Array<{ query: string }>;
    expect(parsed[0]?.query).toBe("pkgr1");
  });
  test("three packages collapse to compact rows", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("security.snyk.io")) {
        return { status: 200, ok: true, text: async () => HEALTH_HTML };
      }
      const name = u.split("/").at(-2) ?? "";
      return {
        status: 200,
        ok: true,
        json: async () => ({ name, version: "1.0.0", dependencies: {} }),
      };
    }) as unknown as typeof fetch;
    await run(["ca1", "cb1", "cc1", "--dry-run", "--pm", "bun"]);
    expect(output()).toContain("0d, 0t");
  });
  test("aborts without -y off a TTY", async () => {
    stubRegistry();
    const origTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      await run(["add", "pkgr1", "--pm", "bun"]);
      expect(output()).toContain("aborted");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: origTTY, configurable: true });
    }
  });
  test("passthrough help prints help", async () => {
    await run(["run", "--help"]);
    expect(output()).toContain("usage");
  });
  test("passthrough with a bad manager exits 1", async () => {
    await run(["run", "--pm", "wat", "build"]);
    expect(output()).toContain("unsupported package manager");
    expect(process.exitCode).toBe(1);
  });
  test("invalid package name fails at intel with a clear error", async () => {
    stubRegistry([]);
    await run(["add", "@", "--dry-run", "--pm", "yarn"]);
    expect(output()).toContain('invalid package name "@"');
    expect(process.exitCode).toBe(1);
  });
  test("unknown --pm on install flow exits 1", async () => {
    await run(["add", "okpkg", "--dry-run", "--pm", "wat2"]);
    expect(output()).toContain("unsupported package manager");
    expect(process.exitCode).toBe(1);
  });
  test("all lookups failing exits 1", async () => {
    stubRegistry([]);
    await run(["add", "missing1", "--dry-run", "--pm", "bun"]);
    expect(output()).toContain("nothing to install");
    expect(process.exitCode).toBe(1);
  });
  test("-g flag with npm errors (in-process engine)", async () => {
    await run(["add", "pkgr1", "-g", "--dry-run", "--pm", "npm"]);
    expect(output()).toContain("not supported with npm");
    expect(process.exitCode).toBe(1);
  });
  test("-g flag with yarn errors (in-process engine)", async () => {
    await run(["add", "pkgr1", "--global", "--dry-run", "--pm", "yarn"]);
    expect(output()).toContain("not supported with yarn");
    expect(process.exitCode).toBe(1);
  });
  test("-g flag on passthrough is forwarded, not blocked", async () => {
    await run(["run", "-g", "--dry-run", "build"]);
    expect(output()).toContain("dry-run");
    expect(process.exitCode).toBe(0);
  });
  test("-g flag with bun works (binary engine)", async () => {
    stubRegistry(["pkgr1"]);
    await run(["add", "pkgr1", "-g", "--dry-run", "--pm", "bun"]);
    expect(output()).toContain("bun add");
    expect(output()).toContain("-g");
    expect(process.exitCode).toBe(0);
  });
  test("non-registry spec (GitHub shorthand) installs with warning", async () => {
    await run(["add", "user/repo", "--dry-run", "--pm", "bun", "-y"]);
    expect(output()).toContain("non-registry spec");
    expect(output()).toContain("user/repo");
    expect(process.exitCode).toBe(0);
  });
  test("non-registry spec (file:) installs with warning", async () => {
    await run(["add", "file:../local", "--dry-run", "--pm", "bun", "-y"]);
    expect(output()).toContain("non-registry spec");
    expect(output()).toContain("file:../local");
    expect(process.exitCode).toBe(0);
  });
  test("-P maps to the PM-native peer flag", async () => {
    stubRegistry(["pkgr1"]);
    await run(["add", "pkgr1", "-P", "--dry-run", "--pm", "pnpm"]);
    expect(output()).toContain("--save-peer");
    expect(output()).not.toContain(" -P");
    expect(process.exitCode).toBe(0);
  });
  test("-O maps to the PM-native optional flag", async () => {
    stubRegistry(["pkgr1"]);
    await run(["add", "pkgr1", "-O", "--dry-run", "--pm", "bun"]);
    expect(output()).toContain("--optional");
    expect(process.exitCode).toBe(0);
  });
  test("-D with -P errors uniformly", async () => {
    await run(["add", "pkgr1", "-D", "-P", "--dry-run", "--pm", "bun"]);
    expect(output()).toContain("cannot combine");
    expect(process.exitCode).toBe(1);
  });
  test("--filter on an engine errors with the wrapper equivalent", async () => {
    await run(["add", "pkgr1", "--filter", "api", "--dry-run", "--pm", "npm"]);
    expect(output()).toContain("--filter is not supported with npm");
    expect(output()).toContain("--workspace");
    expect(process.exitCode).toBe(1);
  });
  test("-w translates to --filter on binaries", async () => {
    stubRegistry(["pkgr1"]);
    await run(["add", "pkgr1", "-w", "api", "--dry-run", "--pm", "bun"]);
    expect(output()).toContain("--filter api");
    expect(output()).toContain("(workspace: api)");
    expect(process.exitCode).toBe(0);
  });
  test("--workspace with brew errors", async () => {
    // Runs in a config-free temp dir: the repo root disables brew via its
    // own nps.config.json, which would fail before reaching this guard.
    const prev = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), "nps-run-brew-"));
    process.chdir(dir);
    try {
      await run(["add", "pkgr1", "--workspace", "api", "--dry-run", "--pm", "brew"]);
      expect(output()).toContain("not supported with brew");
      expect(process.exitCode).toBe(1);
    } finally {
      process.chdir(prev);
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("disabled manager fails before intel", async () => {
    const prev = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), "nps-run-disabled-"));
    writeFileSync(
      join(dir, "nps.config.json"),
      JSON.stringify({ packageManagers: { bun: { enabled: false } } }),
    );
    process.chdir(dir);
    try {
      await run(["add", "pkgr1", "--dry-run", "--pm", "bun"]);
      expect(output()).toContain('package manager "bun" is disabled');
      expect(process.exitCode).toBe(1);
    } finally {
      process.chdir(prev);
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("--registry reaches the binary plan and status line", async () => {
    stubRegistry(["pkgr1"]);
    await run(["add", "pkgr1", "--registry", "https://r.example.com", "--dry-run", "--pm", "bun"]);
    expect(output()).toContain("--registry https://r.example.com");
    expect(output()).toContain("(registry: https://r.example.com)");
    expect(process.exitCode).toBe(0);
  });
  test("unparsable snyk health warns but still installs", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("security.snyk.io")) {
        return { status: 200, ok: true, text: async () => "<html>redesigned</html>" };
      }
      const name = u.split("/").at(-2) ?? "";
      return {
        status: 200,
        ok: true,
        json: async () => ({
          name,
          version: "1.0.0",
          description: `${name} package`,
          author: "tester",
          license: "MIT",
          repository: "https://github.com/test/test",
          dependencies: {},
          maintainers: [],
        }),
      };
    }) as unknown as typeof fetch;
    await run(["add", "pkgr1", "--dry-run", "--pm", "bun"]);
    expect(output()).toContain("snyk health unparsable");
    expect(output()).toContain("unknown, not healthy");
    expect(process.exitCode).toBe(0);
  });
  test("mix of registry and non-registry specs", async () => {
    stubRegistry(["pkgr1"]);
    await run(["add", "pkgr1", "user/repo", "--dry-run", "--pm", "bun", "-y"]);
    expect(output()).toContain("pkgr1");
    expect(output()).toContain("non-registry spec");
    expect(output()).toContain("user/repo");
    expect(process.exitCode).toBe(0);
  });
  test("low health prints a pre-prompt warning", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("security.snyk.io")) {
        return { status: 200, ok: true, text: async () => `<span class="score-number">20/100</span>` };
      }
      return {
        status: 200,
        ok: true,
        json: async () => ({
          name: "pkgr1",
          version: "1.0.0",
          description: "risky package",
          author: "tester",
          license: "MIT",
          repository: "https://github.com/test/test",
          dependencies: {},
          maintainers: [],
        }),
      };
    }) as unknown as typeof fetch;
    await run(["add", "pkgr1", "--dry-run", "--pm", "bun"]);
    expect(output()).toContain("low health score");
    expect(process.exitCode).toBe(0);
  });
  test("unreachable health prints an unavailable note", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("security.snyk.io")) {
        return { status: 503, ok: false, text: async () => "" };
      }
      return {
        status: 200,
        ok: true,
        json: async () => ({
          name: "pkgr1",
          version: "1.0.0",
          dependencies: {},
        }),
      };
    }) as unknown as typeof fetch;
    await run(["add", "pkgr1", "--dry-run", "--pm", "bun"]);
    expect(output()).toContain("health unavailable");
    expect(process.exitCode).toBe(0);
  });
  test("all lookups failing exits 1", async () => {
    stubRegistry([]);
    await run(["add", "missing1", "--dry-run", "--pm", "bun"]);
    expect(output()).toContain("nothing to install");
    expect(process.exitCode).toBe(1);
  });
});
