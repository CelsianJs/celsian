// @celsian/cli -- Locate and inspect the user's exported CelsianApp

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Entry files probed, in order, when no explicit entry is given. */
export const DEFAULT_ENTRY_CANDIDATES = ["src/index.ts", "src/app.ts", "src/server.ts", "index.ts"];

const NO_APP_MARKER = "__CELSIAN_NO_APP__";
const RESULT_MARKER = "__CELSIAN_APP__:";

export interface RouteInfo {
  method: string;
  url: string;
  kind: string;
}

export interface AppProbeResult {
  /** Absolute path of the entry file that was loaded. */
  entryPath: string;
  /** Which export holds the app: the default export, or the named `app` export. */
  exportName: "default" | "app";
  routes: RouteInfo[];
}

/** Why a probe failed, so callers can print an appropriate message. */
export type AppProbeFailure =
  | { reason: "no-app" }
  | { reason: "load-failed"; detail: string }
  | { reason: "bad-output" };

export class AppProbeError extends Error {
  readonly failure: AppProbeFailure;

  constructor(failure: AppProbeFailure) {
    super(failure.reason === "load-failed" ? failure.detail : failure.reason);
    this.name = "AppProbeError";
    this.failure = failure;
  }
}

/**
 * Pick the first existing entry candidate. Returns null when none exist.
 */
export function findDefaultEntry(cwd: string): string | null {
  for (const candidate of DEFAULT_ENTRY_CANDIDATES) {
    const abs = resolve(cwd, candidate);
    if (existsSync(abs)) return abs;
  }
  return null;
}

/**
 * Load the user's entry module with tsx and report which export holds the
 * CelsianApp plus the routes it registered.
 *
 * Runs in a child process because the entry is TypeScript, may use top-level
 * await, and commonly calls `serve()` on import.
 */
export function probeApp(entryPath: string, cwd: string): AppProbeResult {
  // Written to a temp .mts file rather than passed via `tsx --eval`, because
  // --eval compiles to CJS, which rejects the top-level await needed here
  // ("Top-level await is currently not supported with the cjs output format").
  const loaderScript = `const mod = await import(${JSON.stringify(`file://${entryPath}`)});
const isApp = (v) => !!v && typeof v.getRoutes === 'function';
const exportName = isApp(mod.default) ? 'default' : isApp(mod.app) ? 'app' : null;
if (!exportName) {
  console.error(${JSON.stringify(NO_APP_MARKER)});
  process.exit(1);
}
const app = exportName === 'default' ? mod.default : mod.app;
console.log(${JSON.stringify(RESULT_MARKER)} + JSON.stringify({ exportName, routes: app.getRoutes() }));
// The entry may have called serve(app), leaving a listening server that keeps
// the event loop alive -- exit explicitly now that the data is printed.
process.exit(0);
`;

  const tmpDir = mkdtempSync(join(tmpdir(), "celsian-probe-"));
  const loaderPath = join(tmpDir, "probe-app.mts");

  let output: string;
  try {
    writeFileSync(loaderPath, loaderScript, "utf-8");
    output = execFileSync("npx", ["tsx", loaderPath], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      // This budget covers an `npx tsx` COLD START, not the user's app doing
      // work, so it has to absorb module resolution and a TypeScript transpile
      // on a machine that may be busy. Unloaded it completes in well under a
      // second; on a loaded CI runner (or a laptop mid-build) it was observed
      // hitting the old 30s ceiling and failing a green build for no reason.
      // Overshooting here costs nothing in the normal case: the process exits
      // as soon as it has answered, and the timeout is only ever reached when
      // something is genuinely wrong.
      timeout: 120_000,
      // If the entry calls serve(), bind an ephemeral port so this never fails
      // with EADDRINUSE while the real dev server is running.
      env: { ...process.env, PORT: "0" },
    });
  } catch (error) {
    const err = error as Error & { stderr?: string };
    const stderr = err.stderr ?? "";
    if (stderr.includes(NO_APP_MARKER)) {
      throw new AppProbeError({ reason: "no-app" });
    }
    throw new AppProbeError({ reason: "load-failed", detail: stderr.trim() || err.message });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  // Find our marked JSON line; other lines may be console output from the
  // user's app initialization.
  const jsonLine = output
    .split("\n")
    .reverse()
    .find((line) => line.startsWith(RESULT_MARKER));

  if (!jsonLine) throw new AppProbeError({ reason: "bad-output" });

  try {
    const parsed = JSON.parse(jsonLine.slice(RESULT_MARKER.length)) as {
      exportName: "default" | "app";
      routes: RouteInfo[];
    };
    return { entryPath, exportName: parsed.exportName, routes: parsed.routes };
  } catch {
    throw new AppProbeError({ reason: "bad-output" });
  }
}
