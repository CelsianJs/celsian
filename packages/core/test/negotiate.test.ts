import { describe, expect, it } from "vitest";
import { accepts, acceptsEncoding, acceptsLanguage } from "../src/negotiate.js";

function req(headers: Record<string, string> = {}) {
  return new Request("http://localhost", { headers });
}

describe("Content Negotiation", () => {
  describe("accepts()", () => {
    it("should match exact type", () => {
      const r = req({ accept: "application/json" });
      expect(accepts(r, ["application/json", "text/html"])).toBe("application/json");
    });

    it("should respect quality factors", () => {
      const r = req({ accept: "text/html;q=0.9, application/json;q=1.0" });
      expect(accepts(r, ["text/html", "application/json"])).toBe("application/json");
    });

    it("should handle wildcard */*", () => {
      const r = req({ accept: "*/*" });
      expect(accepts(r, ["application/json"])).toBe("application/json");
    });

    it("should handle subtype wildcard", () => {
      const r = req({ accept: "text/*" });
      expect(accepts(r, ["application/json", "text/html"])).toBe("text/html");
    });

    it("should return null if no match", () => {
      const r = req({ accept: "image/png" });
      expect(accepts(r, ["application/json", "text/html"])).toBeNull();
    });

    it("should default to */* when no Accept header", () => {
      const r = req();
      expect(accepts(r, ["application/json"])).toBe("application/json");
    });

    it("should skip q=0 entries", () => {
      const r = req({ accept: "text/html;q=0, application/json" });
      expect(accepts(r, ["text/html", "application/json"])).toBe("application/json");
    });
  });

  describe("acceptsEncoding()", () => {
    it("should match preferred encoding", () => {
      const r = req({ "accept-encoding": "gzip, deflate, br" });
      expect(acceptsEncoding(r, ["br", "gzip"])).toBe("gzip");
    });

    it("should respect quality factors", () => {
      const r = req({ "accept-encoding": "gzip;q=1.0, br;q=0.5" });
      expect(acceptsEncoding(r, ["br", "gzip"])).toBe("gzip");
    });

    it("should return first available if no header", () => {
      const r = req();
      expect(acceptsEncoding(r, ["gzip", "br"])).toBe("gzip");
    });
  });

  describe("acceptsLanguage()", () => {
    it("should match exact language", () => {
      const r = req({ "accept-language": "en-US, fr;q=0.8" });
      expect(acceptsLanguage(r, ["fr", "en-US"])).toBe("en-US");
    });

    it("should match language prefix", () => {
      const r = req({ "accept-language": "en" });
      expect(acceptsLanguage(r, ["en-US", "fr"])).toBe("en-US");
    });

    it("should handle wildcard", () => {
      const r = req({ "accept-language": "*" });
      expect(acceptsLanguage(r, ["ja", "en"])).toBe("ja");
    });

    it("should return null if no match", () => {
      const r = req({ "accept-language": "zh" });
      expect(acceptsLanguage(r, ["en", "fr"])).toBeNull();
    });
  });
});
