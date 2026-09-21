import { describe, expect, test } from "bun:test";
import { helpText, parseArgs } from "../src/cli.ts";
import { stripAnsi } from "./helper.ts";

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
  test("npms flags are consumed, not forwarded", () => {
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
    for (const f of ["-D", "--dev", "--save-dev"]) {
      expect(parseArgs(["install", "a", f]).opts.dev).toBe(true);
    }
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
  test("mentions npms, usage, and flags", () => {
    const text = stripAnsi(helpText());
    expect(text).toContain("npms");
    expect(text).toContain("usage");
    expect(text).toContain("--dry-run");
    expect(text).toContain("passthrough");
  });
});
