import { describe, expect, it } from "bun:test";
import { buildHooksConfig } from "../../src/utils/hooks-config.js";

describe("buildHooksConfig", () => {
  const baseUrl = "http://127.0.0.1:9999";
  const sessionId = "sess-42";

  function parsed(): {
    hooks: Record<
      string,
      Array<{
        hooks: Array<{ type: string; url: string; async: boolean }>;
      }>
    >;
  } {
    return JSON.parse(buildHooksConfig(baseUrl, sessionId));
  }

  it("produces valid JSON", () => {
    expect(() => JSON.parse(buildHooksConfig(baseUrl, sessionId))).not.toThrow();
  });

  it("registers PermissionRequest as sync (async: false)", () => {
    const cfg = parsed();
    const entry = cfg.hooks.PermissionRequest[0].hooks[0];
    expect(entry.type).toBe("http");
    expect(entry.async).toBe(false);
    expect(entry.url).toBe(`${baseUrl}/hooks/${sessionId}/PermissionRequest`);
  });

  it("registers only PermissionRequest (SessionStart is not HTTP-capable in Claude Code)", () => {
    const cfg = parsed();
    expect(Object.keys(cfg.hooks)).toEqual(["PermissionRequest"]);
  });

  it("embeds the session id in every hook URL", () => {
    const json = buildHooksConfig(baseUrl, sessionId);
    // Every URL should carry the session segment.
    const urls = json.match(/http:\/\/[^"]+/g) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).toContain(`/hooks/${sessionId}/`);
    }
  });

  it("uses the provided base URL verbatim", () => {
    const json = buildHooksConfig("http://example.local:1234", "abc");
    expect(json).toContain("http://example.local:1234/hooks/abc/");
  });
});
