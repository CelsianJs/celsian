// @celsian/cli — `celsian routes` integration tests
// Runs the real loader (temp .mts file + npx tsx) against fixture apps.

import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routesCommand } from "../src/commands/routes.js";

const FIXTURES = join(import.meta.dirname, "fixtures");

// Spawning `npx tsx` per test is slow — allow generous timeouts.
const SPAWN_TIMEOUT = 120_000;

describe("routes command (integration)", () => {
  let originalCwd: string;
  let logLines: string[];
  let errorLines: string[];

  beforeEach(() => {
    originalCwd = process.cwd();
    logLines = [];
    errorLines = [];
    vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      logLines.push(String(msg));
    });
    vi.spyOn(console, "error").mockImplementation((msg?: unknown) => {
      errorLines.push(String(msg));
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
  });

  it(
    "lists routes for an app exported as `export const app` (even when serve() is called)",
    async () => {
      process.chdir(join(FIXTURES, "named-export"));
      await routesCommand();
      const output = logLines.join("\n");
      expect(output).toContain("GET");
      expect(output).toContain("/health");
      expect(output).toContain("/hello/:name");
      expect(output).toContain("POST");
      expect(output).toContain("/items");
      expect(errorLines.join("\n")).toBe("");
    },
    SPAWN_TIMEOUT,
  );

  it(
    "lists routes for an app exported as default",
    async () => {
      process.chdir(join(FIXTURES, "default-export"));
      await routesCommand();
      const output = logLines.join("\n");
      expect(output).toContain("/ping");
      expect(output).toContain("DELETE");
      expect(output).toContain("/items/:id");
    },
    SPAWN_TIMEOUT,
  );

  it(
    "reports a clear error when the entry has no app export",
    async () => {
      process.chdir(join(FIXTURES, "no-app"));
      await routesCommand();
      const errors = errorLines.join("\n");
      expect(errors).toContain("Could not find a CelsianApp export");
    },
    SPAWN_TIMEOUT,
  );

  it("reports a clear error when the entry file does not exist", async () => {
    process.chdir(FIXTURES);
    await routesCommand("src/does-not-exist.ts");
    expect(errorLines.join("\n")).toContain("Entry file not found");
  });
});
