import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  arboristRegistryOpts,
  authHeaders,
  DEFAULT_REGISTRY,
  loadNpmrc,
  nerf,
  registryFor,
} from "../src/npmrc.ts";

const realHome = process.env.HOME;
const realToken = process.env.NPM_TOKEN;
const realReg = process.env.NPM_CONFIG_REGISTRY;
const realRegLower = process.env.npm_config_registry;

afterEach(() => {
  process.env.HOME = realHome;
  if (realToken === undefined) delete process.env.NPM_TOKEN;
  else process.env.NPM_TOKEN = realToken;
  if (realReg === undefined) delete process.env.NPM_CONFIG_REGISTRY;
  else process.env.NPM_CONFIG_REGISTRY = realReg;
  if (realRegLower === undefined) delete process.env.npm_config_registry;
  else process.env.npm_config_registry = realRegLower;
});

function proj(files: Record<string, string>, homeFiles: Record<string, string> = {}): string {
  const home = mkdtempSync(join(tmpdir(), "nps-home-"));
  process.env.HOME = home;
  for (const [name, content] of Object.entries(homeFiles)) {
    writeFileSync(join(home, name), content);
  }
  const dir = mkdtempSync(join(tmpdir(), "nps-npmrc-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  if (process.env.HOME?.includes("nps-home-")) {
    rmSync(process.env.HOME, { recursive: true, force: true });
  }
}

describe("nerf", () => {
  test("reduces a URL to its //host/ key", () => {
    expect(nerf("https://reg.example.com/some/path")).toBe("//reg.example.com/");
    expect(nerf("https://registry.npmjs.org")).toBe("//registry.npmjs.org/");
  });
});

describe("loadNpmrc", () => {
  test("empty project uses the default registry", () => {
    const dir = proj({});
    try {
      const cfg = loadNpmrc(dir);
      expect(cfg.registry).toBe(DEFAULT_REGISTRY);
      expect(cfg.scoped).toEqual({});
    } finally {
      cleanup(dir);
    }
  });
  test("project registry wins over home", () => {
    const dir = proj(
      { ".npmrc": "registry=https://project.example.com\n" },
      { ".npmrc": "registry=https://home.example.com\n" },
    );
    try {
      expect(loadNpmrc(dir).registry).toBe("https://project.example.com");
    } finally {
      cleanup(dir);
    }
  });
  test("home applies when the project has none", () => {
    const dir = proj({}, { ".npmrc": "registry=https://home.example.com\n" });
    try {
      expect(loadNpmrc(dir).registry).toBe("https://home.example.com");
    } finally {
      cleanup(dir);
    }
  });
  test("parses scoped registries and tokens with interpolation", () => {
    process.env.INTERP_TOKEN = "secret1";
    const dir = proj({
      ".npmrc": [
        "@acme:registry=https://npm.acme.com",
        "//npm.acme.com/:_authToken=${INTERP_TOKEN}",
        "",
        "# a comment",
        "; another comment",
      ].join("\n"),
    });
    try {
      const cfg = loadNpmrc(dir);
      expect(cfg.scoped).toEqual({ acme: "https://npm.acme.com" });
      expect(cfg.tokens).toEqual({ "//npm.acme.com/": "secret1" });
    } finally {
      delete process.env.INTERP_TOKEN;
      cleanup(dir);
    }
  });
  test("trailing slashes are normalized", () => {
    const dir = proj({ ".npmrc": "registry=https://r.example.com///\n" });
    try {
      expect(loadNpmrc(dir).registry).toBe("https://r.example.com");
    } finally {
      cleanup(dir);
    }
  });
});

describe("registryFor", () => {
  test("flag override wins over everything", () => {
    const dir = proj({ ".npmrc": "registry=https://rc.example.com\n" });
    try {
      const cfg = loadNpmrc(dir);
      expect(registryFor("x", cfg, "https://flag.example.com/")).toBe("https://flag.example.com");
    } finally {
      cleanup(dir);
    }
  });
  test("scoped mapping wins for its scope", () => {
    const dir = proj({ ".npmrc": "@acme:registry=https://npm.acme.com\n" });
    try {
      const cfg = loadNpmrc(dir);
      expect(registryFor("@acme/pkg", cfg, null)).toBe("https://npm.acme.com");
      expect(registryFor("other", cfg, null)).toBe(DEFAULT_REGISTRY);
    } finally {
      cleanup(dir);
    }
  });
  test("NPM_CONFIG_REGISTRY env beats the file default", () => {
    process.env.NPM_CONFIG_REGISTRY = "https://env.example.com";
    const dir = proj({ ".npmrc": "registry=https://rc.example.com\n" });
    try {
      const cfg = loadNpmrc(dir);
      expect(registryFor("x", cfg, null)).toBe("https://env.example.com");
    } finally {
      cleanup(dir);
    }
  });
});

describe("authHeaders", () => {
  test("file token becomes a Bearer header", () => {
    const dir = proj({ ".npmrc": "//r.example.com/:_authToken=tok123\n" });
    try {
      expect(authHeaders("https://r.example.com", loadNpmrc(dir))).toEqual({
        Authorization: "Bearer tok123",
      });
    } finally {
      cleanup(dir);
    }
  });
  test("NPM_TOKEN is the fallback", () => {
    process.env.NPM_TOKEN = "envtok";
    const dir = proj({});
    try {
      expect(authHeaders("https://r.example.com", loadNpmrc(dir))).toEqual({
        Authorization: "Bearer envtok",
      });
    } finally {
      cleanup(dir);
    }
  });
  test("file token wins over NPM_TOKEN", () => {
    process.env.NPM_TOKEN = "envtok";
    const dir = proj({ ".npmrc": "//r.example.com/:_authToken=filetok\n" });
    try {
      expect(authHeaders("https://r.example.com", loadNpmrc(dir))).toEqual({
        Authorization: "Bearer filetok",
      });
    } finally {
      cleanup(dir);
    }
  });
  test("anonymous when nothing configured", () => {
    const dir = proj({});
    try {
      expect(authHeaders("https://r.example.com", loadNpmrc(dir))).toEqual({});
    } finally {
      cleanup(dir);
    }
  });
});

describe("arboristRegistryOpts", () => {
  test("emits registry, scoped, and token keys", () => {
    const dir = proj({
      ".npmrc": "@acme:registry=https://npm.acme.com\n//npm.acme.com/:_authToken=t1\n",
    });
    try {
      const opts = arboristRegistryOpts(loadNpmrc(dir), null);
      expect(opts["registry"]).toBe(DEFAULT_REGISTRY);
      expect(opts["@acme:registry"]).toBe("https://npm.acme.com");
      expect(opts["//npm.acme.com/:_authToken"]).toBe("t1");
    } finally {
      cleanup(dir);
    }
  });
  test("override replaces the default registry key", () => {
    const dir = proj({});
    try {
      const opts = arboristRegistryOpts(loadNpmrc(dir), "https://flag.example.com");
      expect(opts["registry"]).toBe("https://flag.example.com");
    } finally {
      cleanup(dir);
    }
  });
});
