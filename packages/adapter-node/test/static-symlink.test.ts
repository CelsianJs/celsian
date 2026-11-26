// @celsian/adapter-node -- serve({ staticDir }) must not follow a symlink out of the root
//
// Core's serve() was hardened against this in 0.6.0. This package carried a
// second copy of the static-file logic that kept only the lexical check: it
// compared the resolved path with `startsWith`, then `stat` + `readFile` by
// name, both of which follow symlinks. A link planted inside staticDir (an
// upload, an extracted archive) was served with a 200, whatever it pointed at.

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../core/src/app.js";
import { serve } from "../src/index.js";

/** Find an available TCP port. */
async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Locate the listening http.Server bound to a given port via active handles. */
function findServerOnPort(port: number): Server | null {
  // The adapter's serve() returns nothing, so there is no handle to close.
  // process._getActiveHandles is undocumented but stable enough for teardown.
  const handles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? [];
  for (const h of handles) {
    const maybe = h as { address?: () => unknown };
    if (typeof maybe.address === "function") {
      const addr = maybe.address();
      if (addr && typeof addr === "object" && (addr as { port?: number }).port === port) return h as Server;
    }
  }
  return null;
}

/** Poll until the server on `port` answers, instead of sleeping a fixed time. */
async function waitUntilListening(port: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (findServerOnPort(port)?.listening) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`server on port ${port} never started listening`);
}

let tmp = "";
let staticDir = "";
let port = 0;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "celsian-adapter-node-static-"));
  staticDir = join(tmp, "public");
  await mkdir(join(staticDir, "assets"), { recursive: true });
  await mkdir(join(tmp, "private"));

  await writeFile(join(tmp, "secret.env"), "DB_PASSWORD=hunter2\n");
  await writeFile(join(tmp, "private", "notes.txt"), "PRIVATE NOTES\n");
  await writeFile(join(staticDir, "real.txt"), "public asset");
  await writeFile(join(staticDir, "assets", "app.js"), "console.log('app');");

  // The exploit: links planted inside the served root, pointing out of it.
  await symlink(join(tmp, "secret.env"), join(staticDir, "avatar.png"));
  await symlink(join(tmp, "private"), join(staticDir, "linked-dir"));
  // A link that stays inside the root is ordinary and must keep working.
  await symlink(join(staticDir, "real.txt"), join(staticDir, "alias.txt"));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  const srv = findServerOnPort(port);
  if (srv) {
    srv.closeAllConnections?.();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

async function start(): Promise<string> {
  const app = createApp();
  app.get("/ok", (_req, reply) => reply.json({ ok: true }));
  port = await freePort();
  vi.spyOn(console, "log").mockImplementation(() => {});
  serve(app, { port, host: "127.0.0.1", staticDir });
  await waitUntilListening(port);
  return `http://127.0.0.1:${port}`;
}

describe("adapter-node serve({ staticDir }) symlink confinement", () => {
  it("does not serve a symlinked file that points outside staticDir", async () => {
    const base = await start();

    const res = await fetch(`${base}/avatar.png`);
    const body = await res.text();

    expect(body).not.toContain("hunter2");
    // Falls through to the app, which has no such route.
    expect(res.status).toBe(404);
  });

  it("does not serve files reached through a symlinked directory that leaves staticDir", async () => {
    const base = await start();

    const res = await fetch(`${base}/linked-dir/notes.txt`);
    const body = await res.text();

    expect(body).not.toContain("PRIVATE NOTES");
    expect(res.status).toBe(404);
  });

  it("still serves real files, nested files and symlinks that stay inside staticDir", async () => {
    const base = await start();

    const real = await fetch(`${base}/real.txt`);
    expect(real.status).toBe(200);
    expect(await real.text()).toBe("public asset");
    expect(real.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

    const nested = await fetch(`${base}/assets/app.js`);
    expect(nested.status).toBe(200);
    expect(nested.headers.get("content-type")).toBe("application/javascript");
    expect(await nested.text()).toBe("console.log('app');");

    const alias = await fetch(`${base}/alias.txt`);
    expect(alias.status).toBe(200);
    expect(await alias.text()).toBe("public asset");
  });

  it("still hands directories and unknown paths to the app", async () => {
    const base = await start();

    const dir = await fetch(`${base}/assets`);
    expect(dir.status).toBe(404);
    await dir.text();

    const ok = await fetch(`${base}/ok`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
  });
});
