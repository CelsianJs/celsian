// celsian -- umbrella re-export surface tests (CORE-12)

import { describe, expect, it } from "vitest";
import * as celsian from "../src/index.js";

describe("celsian umbrella re-exports", () => {
  it("re-exports core app + server APIs", () => {
    expect(typeof celsian.createApp).toBe("function");
    expect(typeof celsian.serve).toBe("function");
    expect(typeof celsian.CelsianApp).toBe("function");
  });

  it("re-exports security plugins documented in the README (csrf, etag)", () => {
    expect(typeof celsian.csrf).toBe("function");
    expect(typeof celsian.withETag).toBe("function");
    expect(typeof celsian.cors).toBe("function");
    expect(typeof celsian.security).toBe("function");
  });

  it("re-exports analytics helpers (trackedPool, dbAnalytics, dbTimingHeader, slowQueryLogger)", () => {
    expect(typeof celsian.trackedPool).toBe("function");
    expect(typeof celsian.dbAnalytics).toBe("function");
    expect(typeof celsian.dbTimingHeader).toBe("function");
    expect(typeof celsian.slowQueryLogger).toBe("function");
  });

  it("re-exports database helpers", () => {
    expect(typeof celsian.database).toBe("function");
    expect(typeof celsian.withTransaction).toBe("function");
    expect(typeof celsian.transactionLifecycle).toBe("function");
  });

  it("re-exports structured error classes", () => {
    expect(typeof celsian.CelsianError).toBe("function");
    expect(typeof celsian.HttpError).toBe("function");
    expect(typeof celsian.ValidationError).toBe("function");
  });
});
