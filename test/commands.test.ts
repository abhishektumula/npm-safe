import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProjectDeps, runChecks, runTool } from "../src/commands.ts";
import { completionScript, aliasSnippet, SHELLS } from "../src/completions.ts";
import { clearIntelCache } from "../src/cache.ts";
import { clearNpmInflight } from "../src/npm.ts";
import { clearHealthInflight } from "../src/snyk.ts";
import { clearOsvInflight } from "../src/osv.ts";
import { clearDepsCache } from "../src/deps.ts";
import { clearPolicyCache } from "../src/policy.ts";
import { clearPmConfigCache } from "../src/pmconfig.ts";
import { clearNpmrcCache } from "../src/npmrc.ts";
import { parseArgs } from "../src/cli.ts";
import { stripAnsi } from "./helper.ts";

const realFetch = globalThis.fetch;
const realLog = console.log;
const realError = console.error;
let logs: string[] = [];
let errors: string[] = [];
let dir = "";
const realCacheDir = process.env.NPS_CACHE_DIR;

const opts = () => parseArgs(["scan"]).opts;

beforeEach(() => {
  logs = [];
  errors = [];
  dir = mkdtempSync(join(tmpdir(), "nps-cmd-"));
  process.env.NPS_CACHE_DIR = join(dir, "cache"); // never touch the real cache
  for (const f of [
    clearIntelCache,
    clearNpmInflight,
    clearHealthInflight,
    clearOsvInflight,
    clearDepsCache,
    clearPolicyCache,
    clearPmConfigCache,
    clearNpmrcCache,
  ])
    f();
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
});
afterEach(() => {
  console.log = realLog;
  console.error = realError;
  globalThis.fetch = realFetch;
  if (realCacheDir === undefined) delete process.env.NPS_CACHE_DIR;
  else process.env.NPS_CACHE_DIR = realCacheDir;
  rmSync(dir, { recursive: true, force: true });
});

const out = () => stripAnsi([...logs, ...errors].join("\n"));

/** Registry knows `names` (score by name), OSV flags `vulnerable`. */
function stub(names: Record<string, number>, vulnerable: string[] = []) {
  globalThis.fetch = (async (url: string | URL | Request, init?: { body?: string }) => {
    const u = String(url);
    if (u.includes("api.osv.dev")) {
      const name = JSON.parse(init!.body!).package.name as string;
      const payload = vulnerable.includes(name)
        ? { vulns: [{ id: "GHSA-x", database_specific: { severity: "HIGH" } }] }
        : {};
      return { status: 200, ok: true, text: async () => JSON.stringify(payload) };
    }
    if (u.includes("security.snyk.io")) {
      const name = u.split("/npm/")[1]!;
      return {
        status: 200,
        ok: true,
        text: async () => `<span class="score-number">${names[name] ?? 0}/100</span>`,
      };
    }
    const name = u.split("/").at(-2) ?? "";
    if (!(name in names)) return { status: 404, ok: false, json: async () => ({}) };
    return {
      status: 200,
      ok: true,
      json: async () => ({
        name,
        version: "2.0.0",
        license: "MIT",
        dependencies: {},
        scripts: name === "scripty" ? { postinstall: "node x.js" } : {},
      }),
    };
  }) as unknown as typeof fetch;
}

function project(deps: Record<string, string>, dev: Record<string, string> = {}) {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "p", dependencies: deps, devDependencies: dev }),
  );
}

describe("readProjectDeps", () => {
  test("splits registry vs non-registry, reads installed versions, honors --prod", () => {
    project(
      {
        alpha: "^1.0.0",
        fromgit: "user/repo",
        local: "file:../x",
        ws: "workspace:*",
        gh: "github:u/r",
      },
      { beta: "^2" },
    );
    mkdirSync(join(dir, "node_modules", "alpha"), { recursive: true });
    writeFileSync(
      join(dir, "node_modules", "alpha", "package.json"),
      JSON.stringify({ version: "1.4.2" }),
    );
    const all = readProjectDeps(dir, false);
    expect(all.names).toEqual(["alpha", "beta"]);
    expect(all.installed).toEqual({ alpha: "1.4.2" });
    expect(all.skipped.sort()).toEqual(["fromgit", "gh", "local", "ws"]);
    expect(readProjectDeps(dir, true).names).toEqual(["alpha"]);
  });
});

describe("workspaces", () => {
  const member = (rel: string, pkg: object) => {
    mkdirSync(join(dir, rel), { recursive: true });
    writeFileSync(join(dir, rel, "package.json"), JSON.stringify(pkg));
  };
  test("array form with dir/* and literal dirs; members' deps included, member names excluded", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "root",
        workspaces: ["packages/*", "tools/cli", "!packages/skip", "deep/**"],
        dependencies: { rootdep: "^1" },
      }),
    );
    member("packages/a", { name: "@me/a", dependencies: { adep: "^1", "@me/b": "*" } });
    member("packages/b", { name: "@me/b", devDependencies: { bdev: "^1" } });
    member("tools/cli", { name: "cli", dependencies: { clidep: "^1" } });
    mkdirSync(join(dir, "packages", "no-manifest"), { recursive: true });
    const r = readProjectDeps(dir, false);
    expect(r.names).toEqual(["adep", "bdev", "clidep", "rootdep"]);
    expect(r.workspaces.sort()).toEqual(["@me/a", "@me/b", "cli"]);
    expect(readProjectDeps(dir, true).names).toEqual(["adep", "clidep", "rootdep"]);
  });
  test("{ packages } form; unreadable member is ignored", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "root", workspaces: { packages: ["libs/*"] } }),
    );
    member("libs/x", { name: "x", dependencies: { xdep: "^1" } });
    mkdirSync(join(dir, "libs", "bad"), { recursive: true });
    writeFileSync(join(dir, "libs", "bad", "package.json"), "{nope");
    expect(readProjectDeps(dir, false).names).toEqual(["xdep"]);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "root", workspaces: 5 }));
    expect(readProjectDeps(dir, false).workspaces).toEqual([]);
  });
  test("scan prints which workspaces it included", async () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
    );
    member("packages/a", { name: "wsa", dependencies: { goodpkg: "^1" } });
    stub({ goodpkg: 90 });
    await runTool("scan", [], opts(), dir);
    expect(out()).toContain("workspaces included: wsa");
  });
});

describe("nps scan", () => {
  test("lists deps worst-first and exits 0 without policy", async () => {
    project({ goodpkg: "^1", badpkg: "^1" });
    stub({ goodpkg: 90, badpkg: 10 }, ["badpkg"]);
    const code = await runTool("scan", [], opts(), dir);
    const text = out();
    expect(code).toBe(0);
    expect(text.indexOf("badpkg")).toBeLessThan(text.indexOf("goodpkg"));
    expect(text).toContain("1 of 2 with known advisories");
  });
  test("policy violation exits 3", async () => {
    project({ goodpkg: "^1", badpkg: "^1" });
    stub({ goodpkg: 90, badpkg: 10 });
    const o = opts();
    o.minScore = 50;
    const code = await runTool("scan", [], o, dir);
    expect(code).toBe(3);
    expect(out()).toContain("blocked by policy");
    expect(out()).toContain("below min-score 50");
  });
  test("passing policy says so", async () => {
    project({ goodpkg: "^1" });
    stub({ goodpkg: 90 });
    const o = opts();
    o.minScore = 50;
    expect(await runTool("scan", [], o, dir)).toBe(0);
    expect(out()).toContain("policy passed");
  });
  test("every lookup failing exits 4", async () => {
    project({ ghostpkg: "^1" });
    stub({});
    expect(await runTool("scan", [], opts(), dir)).toBe(4);
    expect(out()).toContain("ghostpkg");
  });
  test("--json emits one scan document", async () => {
    project({ goodpkg: "^1" });
    stub({ goodpkg: 90 });
    const o = opts();
    o.json = true;
    await runTool("scan", [], o, dir);
    const doc = JSON.parse(logs[0]!) as { command: string; packages: unknown[] };
    expect(doc.command).toBe("scan");
    expect(doc.packages).toHaveLength(1);
  });
  test("signals show as warnings", async () => {
    project({ scripty: "^1" });
    stub({ scripty: 90 });
    await runTool("scan", [], opts(), dir);
    expect(out()).toContain("runs code on install: postinstall");
  });
  test("no package.json / empty deps / bad JSON", async () => {
    expect(await runTool("scan", [], opts(), dir)).toBe(1);
    expect(out()).toContain("no package.json");
    project({});
    expect(await runTool("scan", [], opts(), dir)).toBe(0);
    expect(out()).toContain("no registry dependencies");
    writeFileSync(join(dir, "package.json"), "{bad");
    expect(await runTool("scan", [], opts(), dir)).toBe(1);
    expect(out()).toContain("cannot read package.json");
  });
});

describe("nps doctor", () => {
  test("all green when every source answers", async () => {
    globalThis.fetch = (async () => ({
      status: 200,
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
    })) as unknown as typeof fetch;
    project({});
    const checks = await runChecks(opts(), dir);
    expect(checks.map((c) => c.label)).toEqual([
      "nps",
      "package manager",
      "config",
      "cache",
      "registry",
      "snyk health",
      "osv advisories",
      "deps.dev",
    ]);
    expect(checks.every((c) => c.status !== "fail")).toBe(true);
    const code = await runTool("doctor", [], opts(), dir);
    expect(code).toBe(0);
    expect(out()).toContain("nps doctor");
  });
  test("registry down fails, snyk/osv down only warn", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("/-/ping")) throw new Error("ECONNREFUSED");
      return { status: 503, ok: false, arrayBuffer: async () => new ArrayBuffer(0) };
    }) as unknown as typeof fetch;
    const checks = await runChecks(opts(), dir);
    const by = Object.fromEntries(checks.map((c) => [c.label, c]));
    expect(by["registry"]!.status).toBe("fail");
    expect(by["snyk health"]!.status).toBe("warn");
    expect(by["osv advisories"]!.status).toBe("warn");
    expect(by["deps.dev"]!.status).toBe("warn");
    expect(await runTool("doctor", [], opts(), dir)).toBe(1);
  });
  test("bad --pm shows as a failed check and config is reported", async () => {
    globalThis.fetch = (async () => ({
      status: 200,
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
    })) as unknown as typeof fetch;
    writeFileSync(join(dir, "nps.config.json"), "{}");
    const o = opts();
    o.pmOverride = "wat";
    const checks = await runChecks(o, dir);
    expect(checks.find((c) => c.label === "package manager")!.status).toBe("fail");
    expect(checks.find((c) => c.label === "config")!.detail).toContain("nps.config.json");
  });
});

describe("cache-clear, completions, alias", () => {
  test("cache-clear reports and succeeds", async () => {
    expect(await runTool("cache-clear", [], opts(), dir)).toBe(0);
    expect(out()).toContain("cleared nps intel cache");
  });
  test("completions print for every shell, reject unknown", async () => {
    for (const sh of SHELLS) {
      logs = [];
      expect(await runTool("completions", [sh], opts(), dir)).toBe(0);
      expect(logs[0]).toContain("nps");
    }
    expect(await runTool("completions", ["powershell"], opts(), dir)).toBe(1);
    expect(await runTool("completions", [], opts(), dir)).toBe(1);
    expect(completionScript("bash")).toContain("complete -F _nps nps");
    expect(completionScript("zsh")).toContain("compdef _nps nps");
    expect(completionScript("fish")).toContain("complete -c nps");
  });
  test("alias prints a snippet; unknown tool errors", async () => {
    expect(await runTool("alias", [], opts(), dir)).toBe(0);
    expect(out()).toContain("alias ni=");
    expect(aliasSnippet()).toContain("nps check");
    expect(await runTool("nope", [], opts(), dir)).toBe(1);
  });
});
