import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  DEFAULT_HOST,
  getAllowedOrigins,
  isOriginAllowed,
  isProduction,
} from "../../src/utils/constants.js";

const KEYS = ["NODE_ENV", "ALLOWED_ORIGINS"] as const;
const saved = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
}

describe("constants", () => {
  beforeEach(() => {
    saved.clear();
    for (const key of KEYS) saved.set(key, process.env[key]);
  });

  afterEach(() => {
    for (const key of KEYS) setEnv(key, saved.get(key));
  });

  describe("DEFAULT_HOST", () => {
    it("binds to loopback, never all interfaces", () => {
      expect(DEFAULT_HOST).toBe("127.0.0.1");
      expect(DEFAULT_HOST).not.toBe("0.0.0.0");
    });
  });

  describe("isProduction", () => {
    it("is true only when NODE_ENV is exactly 'production'", () => {
      setEnv("NODE_ENV", "production");
      expect(isProduction()).toBe(true);

      setEnv("NODE_ENV", "development");
      expect(isProduction()).toBe(false);

      setEnv("NODE_ENV", undefined);
      expect(isProduction()).toBe(false);
    });
  });

  describe("getAllowedOrigins — development", () => {
    beforeEach(() => setEnv("NODE_ENV", "development"));

    it("includes the local Vite dev origin", () => {
      expect(getAllowedOrigins()).toContain("http://localhost:4578");
    });

    it("ignores ALLOWED_ORIGINS in development", () => {
      setEnv("ALLOWED_ORIGINS", "https://should-be-ignored.ts.net");
      expect(getAllowedOrigins()).not.toContain("https://should-be-ignored.ts.net");
    });
  });

  describe("getAllowedOrigins — production", () => {
    beforeEach(() => setEnv("NODE_ENV", "production"));

    it("is empty when ALLOWED_ORIGINS is unset (fail closed)", () => {
      setEnv("ALLOWED_ORIGINS", undefined);
      expect(getAllowedOrigins()).toEqual([]);
    });

    it("parses a comma-separated list and trims whitespace", () => {
      setEnv("ALLOWED_ORIGINS", "https://a.ts.net, https://b.ts.net");
      expect(getAllowedOrigins()).toEqual(["https://a.ts.net", "https://b.ts.net"]);
    });

    it("drops empty entries from a sloppy list", () => {
      setEnv("ALLOWED_ORIGINS", "https://a.ts.net,, ,");
      expect(getAllowedOrigins()).toEqual(["https://a.ts.net"]);
    });
  });

  describe("isOriginAllowed — production (fail closed)", () => {
    beforeEach(() => setEnv("NODE_ENV", "production"));

    it("denies a request with no Origin header", () => {
      setEnv("ALLOWED_ORIGINS", "https://laptop.ts.net");
      expect(isOriginAllowed(undefined)).toBe(false);
    });

    it("denies every origin when the allowlist is empty", () => {
      setEnv("ALLOWED_ORIGINS", undefined);
      expect(isOriginAllowed("https://laptop.ts.net")).toBe(false);
    });

    it("allows an origin present in the allowlist", () => {
      setEnv("ALLOWED_ORIGINS", "https://laptop.ts.net");
      expect(isOriginAllowed("https://laptop.ts.net")).toBe(true);
    });

    it("denies an origin not in the allowlist", () => {
      setEnv("ALLOWED_ORIGINS", "https://laptop.ts.net");
      expect(isOriginAllowed("https://evil.example.com")).toBe(false);
    });

    it("matches one of several allowed origins", () => {
      setEnv("ALLOWED_ORIGINS", "https://a.ts.net,https://b.ts.net");
      expect(isOriginAllowed("https://b.ts.net")).toBe(true);
    });
  });

  describe("isOriginAllowed — development (lenient)", () => {
    beforeEach(() => setEnv("NODE_ENV", "development"));

    it("allows requests with no Origin header (local tools)", () => {
      expect(isOriginAllowed(undefined)).toBe(true);
    });

    it("allows a matching localhost origin", () => {
      expect(isOriginAllowed("http://localhost:4578")).toBe(true);
    });

    it("denies a present non-matching origin (e.g. a LAN address)", () => {
      expect(isOriginAllowed("http://192.168.1.5:4578")).toBe(false);
    });
  });
});
