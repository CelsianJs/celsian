// @celsian/adapter-node — public surface honesty test

import { describe, expect, it } from "vitest";
import * as adapterNode from "../src/index.js";

describe("@celsian/adapter-node public surface", () => {
  it("no longer exports a build adapter with buildEnd()", () => {
    // buildEnd() depended on a `@celsian/build` pipeline that does not exist; it
    // could only throw. Shipping it as a documented API was dishonest, so the
    // whole build-adapter surface was removed.
    const exported = adapterNode as unknown as Record<string, unknown>;
    expect(exported.ThenAdapter).toBeUndefined();
    expect((exported.default as Record<string, unknown> | undefined)?.buildEnd).toBeUndefined();
    expect((exported.default as Record<string, unknown> | undefined)?.entryTemplate).toBeUndefined();
  });

  it("exports serve() as the supported way to run a CelsianApp on Node", () => {
    expect(typeof adapterNode.serve).toBe("function");
    expect(adapterNode.default).toBe(adapterNode.serve);
  });

  it("exports the Node/Web conversion helpers", () => {
    expect(typeof adapterNode.nodeToWebRequest).toBe("function");
    expect(typeof adapterNode.writeWebResponse).toBe("function");
  });
});
