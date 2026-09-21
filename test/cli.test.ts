import { describe, expect, test } from "bun:test";
import {
  helpText,
  LOW_HEALTH_THRESHOLD,
  parseArgs,
  registrySuffix,
  saveFlagsSuffix,
  warnOnLowHealth,
  workspaceSuffix,
} from "../src/cli.ts";
import { stripAnsi } from "./helper.ts";

describe("warnOnLowHealth", () => {
  const logs: string[] = [];
  const realLog = console.log;
  function report(overrides = {}) {
    return {
      query: "pkg",
      meta: null,
      metaError: null,
      health: { score: 80, breakdown: null },
      directCount: 0,
      transitiveCount: 0,
      totalCount: 0,
      transitiveNames: [],
      truncated: false,
      elapsedMs: 1,
      ...overrides,
    };
  }
  test("warns on low scores and unknown health, skips unparsed", () => {
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      warnOnLowHealth([
        report({ query: "low", health: { score: LOW_HEALTH_THRESHOLD - 1, breakdown: null } }),
        report({ query: "mystery", health: { score: null, breakdown: null } }),
        report({ query: "noparse", health: { score: null, breakdown: null, unparsed: true } }),
        report({ query: "fine", health: { score: 90, breakdown: null } }),
      ]);
      const out = stripAnsi(logs.join("\n"));
      expect(out).toContain("low health score");
      expect(out).toContain("low");
      expect(out).toContain("mystery");
      expect(out).not.toContain("noparse");
      expect(out).not.toContain("fine");
    } finally {
      console.log = realLog;
      logs.length = 0;
    }
  });
});

describe("parseArgs routing", () => {
  test("explicit install verbs", () => {
    for (const verb of ["install", "i", "add"]) {
      const p = parseArgs([verb, "express", "lodash"]);
      expect(p.cmd).toBe("install");
      expect(p.opts.packages).toEqual(["express", "lodash"]);
    }
  });
  test("bare packages mean install", () => {
    const p = parseArgs(["express", "lodash@5"]);
    expect(p.cmd).toBe("install");
    expect(p.opts.packages).toEqual(["express", "lodash@5"]);
  });
  test("passthrough subcommands keep raw args", () => {
    const p = parseArgs(["run", "dev", "--port", "3000"]);
    expect(p.cmd).toBe("passthrough");
    expect(p.subcommand).toBe("run");
    expect(p.passthroughArgs).toEqual(["dev", "--port", "3000"]);
  });
  test("uninstall family passes through", () => {
    for (const sub of ["uninstall", "remove", "rm", "update", "test", "exec"]) {
      expect(parseArgs([sub, "foo"]).cmd).toBe("passthrough");
    }
  });
  test("nps flags are consumed, not forwarded", () => {
    const p = parseArgs(["run", "--dry-run", "dev"]);
    expect(p.passthroughArgs).toEqual(["dev"]);
    expect(p.opts.dryRun).toBe(true);
  });
});

describe("parseArgs flags", () => {
  test("maps every known flag", () => {
    const p = parseArgs(["install", "a", "-a", "-y", "-D", "--dry-run", "--json"]);
    expect(p.opts).toMatchObject({
      packages: ["a"],
      showAll: true,
      yes: true,
      dev: true,
      dryRun: true,
      json: true,
    });
  });
  test("dev flag aliases", () => {
    for (const f of ["-D", "-d", "--dev", "--save-dev"]) {
      expect(parseArgs(["install", "a", f]).opts.dev).toBe(true);
    }
  });
  test("peer flag aliases", () => {
    for (const f of ["-P", "--peer", "--save-peer"]) {
      const p = parseArgs(["install", "a", f]);
      expect(p.opts.peer).toBe(true);
      expect(p.opts.extraArgs).not.toContain(f);
    }
  });
  test("optional flag aliases", () => {
    for (const f of ["-O", "-o", "--optional", "--save-optional"]) {
      const p = parseArgs(["install", "a", f]);
      expect(p.opts.optional).toBe(true);
      expect(p.opts.extraArgs).not.toContain(f);
    }
  });
  test("saveFlagsSuffix combines set flags", () => {
    expect(saveFlagsSuffix({ dev: false, peer: false, optional: false })).toBe("");
    expect(saveFlagsSuffix({ dev: true, peer: false, optional: false })).toBe(" --dev");
    expect(saveFlagsSuffix({ dev: false, peer: true, optional: true })).toBe(" --peer --optional");
  });
  test("workspace flag forms", () => {
    expect(parseArgs(["install", "a", "-w", "api"]).opts.workspace).toBe("api");
    expect(parseArgs(["install", "a", "--workspace", "api"]).opts.workspace).toBe("api");
    expect(parseArgs(["install", "a", "--workspace=api"]).opts.workspace).toBe("api");
    expect(parseArgs(["install", "a"]).opts.workspace).toBeNull();
  });
  test("-w without value is null", () => {
    expect(parseArgs(["install", "a", "-w"]).opts.workspace).toBeNull();
  });
  test("workspace value is not a package", () => {
    const p = parseArgs(["install", "a", "-w", "api"]);
    expect(p.opts.packages).toEqual(["a"]);
    expect(p.opts.extraArgs).not.toContain("-w");
  });
  test("workspaceSuffix", () => {
    expect(workspaceSuffix({ workspace: null })).toBe("");
    expect(workspaceSuffix({ workspace: "api" })).toBe(" (workspace: api)");
  });
  test("registry flag forms", () => {
    expect(parseArgs(["install", "a", "--registry", "https://r.example.com"]).opts.registry).toBe(
      "https://r.example.com",
    );
    expect(parseArgs(["install", "a", "--registry=https://r.example.com"]).opts.registry).toBe(
      "https://r.example.com",
    );
    expect(parseArgs(["install", "a"]).opts.registry).toBeNull();
  });
  test("registry value is not a package", () => {
    const p = parseArgs(["install", "a", "--registry", "https://r.example.com"]);
    expect(p.opts.packages).toEqual(["a"]);
    expect(p.opts.extraArgs).not.toContain("--registry");
  });
  test("registrySuffix redacts embedded credentials", () => {
    expect(registrySuffix({ registry: null })).toBe("");
    expect(registrySuffix({ registry: "https://r.example.com" })).toBe(
      " (registry: https://r.example.com)",
    );
    expect(registrySuffix({ registry: "https://user:pass@r.example.com" })).toBe(
      " (registry: https://***@r.example.com)",
    );
  });
  test("--pm space and equals forms", () => {
    expect(parseArgs(["install", "a", "--pm", "yarn"]).opts.pmOverride).toBe("yarn");
    expect(parseArgs(["install", "a", "--pm=pnpm"]).opts.pmOverride).toBe("pnpm");
  });
  test("--pm without value is null", () => {
    expect(parseArgs(["install", "a", "--pm"]).opts.pmOverride).toBeNull();
  });
  test("help and version", () => {
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-v"]).version).toBe(true);
    expect(parseArgs(["--version"]).version).toBe(true);
  });
  test("unknown flags ride in extraArgs (forwarded, not fatal)", () => {
    const p = parseArgs(["install", "a", "--save-exact", "-E"]);
    expect(p.help).toBe(false);
    expect(p.opts.extraArgs).toEqual(["--save-exact", "-E"]);
  });
  test("-- separator forwards the rest verbatim", () => {
    const p = parseArgs(["install", "a", "--", "--dry-run", "-y"]);
    expect(p.opts.packages).toEqual(["a"]);
    expect(p.opts.extraArgs).toEqual(["--dry-run", "-y"]);
    expect(p.opts.dryRun).toBe(false);
    expect(p.opts.yes).toBe(false);
  });
  test("scoped specs stay whole", () => {
    const p = parseArgs(["add", "@scope/pkg@1.2.3"]);
    expect(p.opts.packages).toEqual(["@scope/pkg@1.2.3"]);
  });
});

describe("helpText", () => {
  test("mentions nps, usage, and flags", () => {
    const text = stripAnsi(helpText());
    expect(text).toContain("nps");
    expect(text).toContain("usage");
    expect(text).toContain("--dry-run");
    expect(text).toContain("passthrough");
  });
});
