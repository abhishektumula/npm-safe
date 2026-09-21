import { afterEach, describe, expect, test } from "bun:test";
import { fetchHealth } from "../src/snyk.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const HTML = `
<span class="score-number">80/100</span>
<span class="criterion-label">security</span><span>No known security issues</span>
<span class="criterion-label">popularity</span><span>Influential project</span>
<span class="criterion-label">maintenance</span><span>Sustained</span>
<span class="criterion-label">community</span><span>Active</span>
`;

function stubHtml(html: string, status = 200) {
  globalThis.fetch = (async () => ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => html,
  })) as unknown as typeof fetch;
}

describe("fetchHealth", () => {
  test("parses score and breakdown", async () => {
    stubHtml(HTML);
    const health = await fetchHealth("express");
    expect(health.score).toBe(80);
    expect(health.breakdown).toMatchObject({
      security: "No known security issues",
      popularity: "Influential project",
      maintenance: "Sustained",
      community: "Active",
    });
  });
  test("non-ok response yields empty health", async () => {
    stubHtml("nope", 404);
    expect(await fetchHealth("x")).toEqual({ score: null, breakdown: null });
  });
  test("network failure yields empty health", async () => {
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    expect(await fetchHealth("x")).toEqual({ score: null, breakdown: null });
  });
  test("page without markers is flagged unparsed, not just empty", async () => {
    stubHtml("<html><body>changed layout</body></html>");
    expect(await fetchHealth("x")).toEqual({ score: null, breakdown: null, unparsed: true });
  });
  test("score without breakdown is parsed, not unparsed", async () => {
    stubHtml(`<span class="score-number">70/100</span><p>redesigned</p>`);
    const health = await fetchHealth("x");
    expect(health.score).toBe(70);
    expect(health.breakdown).toBeNull();
    expect(health.unparsed).toBeUndefined();
  });
  test("breakdown without score is parsed, not unparsed", async () => {
    stubHtml(`<span class="criterion-label">security</span><span>No known security issues</span>`);
    const health = await fetchHealth("x");
    expect(health.score).toBeNull();
    expect(health.breakdown).not.toBeNull();
    expect(health.unparsed).toBeUndefined();
  });
});
