import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { run } from "../src/cli.ts";
import { stripAnsi } from "./helper.ts";

const realFetch = globalThis.fetch;
const realLog = console.log;
const realError = console.error;

let logs: string[];
let errors: string[];

beforeEach(() => {
  logs = [];
  errors = [];
  process.exitCode = 0;
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
    expect(output()).toContain("0.1.0");
    expect(process.exitCode).toBe(0);
  });
  test("no packages prints help", async () => {
    await run([]);
    expect(output()).toContain("usage");
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
    await run(["add", "pkgr1", "--pm", "bun"]);
    expect(output()).toContain("aborted");
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
  test("engine failure in dry-run exits 1", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("security.snyk.io")) {
        return { status: 200, ok: true, text: async () => HEALTH_HTML };
      }
      return {
        status: 200,
        ok: true,
        json: async () => ({
          name: "@",
          version: "1.0.0",
          description: "odd",
          author: "t",
          license: "MIT",
          repository: "https://github.com/test/test",
          dependencies: {},
          maintainers: [],
        }),
      };
    }) as unknown as typeof fetch;
    await run(["add", "@", "--dry-run", "--pm", "yarn"]);
    expect(output()).toContain("invalid package spec");
    expect(process.exitCode).toBe(1);
  });
  test("all lookups failing exits 1", async () => {
    stubRegistry([]);
    await run(["add", "missing1", "--dry-run", "--pm", "bun"]);
    expect(output()).toContain("nothing to install");
    expect(process.exitCode).toBe(1);
  });
});
