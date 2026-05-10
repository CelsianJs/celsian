import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import nodeAdapter from "../src/index.js";

let tmpDir: string;

describe("nodeAdapter buildEnd", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "celsian-adapter-node-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes the generated server entry and static artifact directories", async () => {
    const serverEntry = join(tmpDir, "server", "entry-server.js");
    const clientDir = join(tmpDir, "client");
    const staticDir = join(tmpDir, "static");

    await nodeAdapter.buildEnd({
      serverEntry,
      clientDir,
      staticDir,
      routes: {},
      tasks: {},
    });

    expect(existsSync(serverEntry)).toBe(true);
    expect(existsSync(join(clientDir, ".gitkeep"))).toBe(true);
    expect(existsSync(join(staticDir, ".gitkeep"))).toBe(true);

    const generated = readFileSync(serverEntry, "utf8");
    expect(generated).toContain("createServer");
    expect(generated).toContain("decodeURIComponent");
    expect(generated).toContain("badRequest");
  });
});
