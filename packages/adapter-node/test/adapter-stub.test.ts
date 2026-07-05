// @celsian/adapter-node — buildEnd honesty test

import { describe, expect, it } from "vitest";
import nodeAdapter from "../src/index.js";

describe("nodeAdapter.buildEnd", () => {
  it("fails loud instead of pretending to generate a server entry", async () => {
    // Previously this method logged "Generated server entry" while writing
    // nothing to disk — a silent no-op that misled callers into thinking output
    // was produced. It must now throw a clear not-implemented error.
    await expect(
      nodeAdapter.buildEnd({
        serverEntry: "entry-server.js",
        clientDir: "client",
        staticDir: "static",
        routes: {},
        tasks: {},
      }),
    ).rejects.toThrow(/not implemented/i);
  });

  it("directs callers to the working serve() runtime", async () => {
    await expect(
      nodeAdapter.buildEnd({
        serverEntry: "entry-server.js",
        clientDir: "client",
        staticDir: "static",
        routes: {},
        tasks: {},
      }),
    ).rejects.toThrow(/serve\(/);
  });
});
