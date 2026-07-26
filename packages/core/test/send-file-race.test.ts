// @celsian/core, file serving must not lose a TOCTOU race against a symlink swap
//
// `resolveConfinedPath()` used to hand back a resolved path STRING which
// `sendFile`/`download` then re-opened by name. An attacker who can write inside
// the served root (uploads, extracted archives, the exact scenario
// `allowSymlinks: false` exists for) swaps the leaf for a symlink in that
// window, and the second lookup follows it out of the root. A measured run of
// 2000 concurrent requests leaked 170 responses from outside the root.
//
// The read now happens through a single O_NOFOLLOW handle, so the containment
// check and the bytes served can no longer disagree.

import { mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hook fired from inside the mocked `realpath()`, i.e. after the containment
 * check has resolved a path but before the file is opened. That is precisely the
 * race window, made deterministic.
 */
const raceWindow = vi.hoisted(() => ({ swap: null as null | ((resolved: string) => Promise<void>) }));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    realpath: async (path: Parameters<typeof actual.realpath>[0]) => {
      const resolved = await actual.realpath(path);
      if (raceWindow.swap && typeof resolved === "string") await raceWindow.swap(resolved);
      return resolved;
    },
  };
});

const { createApp } = await import("../src/app.js");

const TMP = join(import.meta.dirname ?? ".", "__tmp_send_file_race__");
const ROOT = join(TMP, "public");
const OUTSIDE = join(TMP, "secrets");
const SECRET = join(OUTSIDE, "passwd.txt");
const SERVED = join(ROOT, "avatar.txt");

beforeAll(async () => {
  await mkdir(ROOT, { recursive: true });
  await mkdir(OUTSIDE, { recursive: true });
  await writeFile(SECRET, "TOP SECRET");
});

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true });
});

beforeEach(async () => {
  raceWindow.swap = null;
  await rm(SERVED, { force: true });
  await writeFile(SERVED, "benign avatar bytes");
});

/** Replace the served leaf with a symlink pointing outside the root. */
async function swapLeafForSymlink(): Promise<void> {
  await unlink(SERVED);
  await symlink(SECRET, SERVED);
}

describe("sendFile, symlink swapped inside the check/read window", () => {
  it("does not serve content from outside the root", async () => {
    raceWindow.swap = async (resolved) => {
      if (resolved.endsWith("avatar.txt")) await swapLeafForSymlink();
    };

    const app = createApp();
    app.get("/f", async (_req, reply) => reply.sendFile("avatar.txt", { root: ROOT }));

    const response = await app.handle(new Request("http://localhost/f"));
    const body = await response.text();
    expect(body).not.toContain("TOP SECRET");
    expect(response.status).toBe(403);
  });

  it("rejects the same swap on download()", async () => {
    raceWindow.swap = async (resolved) => {
      if (resolved.endsWith("avatar.txt")) await swapLeafForSymlink();
    };

    const app = createApp();
    app.get("/d", async (_req, reply) => reply.download("avatar.txt", { root: ROOT }));

    const response = await app.handle(new Request("http://localhost/d"));
    const body = await response.text();
    expect(body).not.toContain("TOP SECRET");
    expect(response.status).toBe(403);
  });

  it("still serves an unswapped file normally", async () => {
    const app = createApp();
    app.get("/f", async (_req, reply) => reply.sendFile("avatar.txt", { root: ROOT }));

    const response = await app.handle(new Request("http://localhost/f"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("benign avatar bytes");
  });

  it("still follows a swapped symlink when allowSymlinks is opted into", async () => {
    // allowSymlinks: true is a documented escape hatch, O_NOFOLLOW is off there.
    await swapLeafForSymlink();

    const app = createApp();
    app.get("/f", async (_req, reply) => reply.sendFile("avatar.txt", { root: ROOT, allowSymlinks: true }));

    const response = await app.handle(new Request("http://localhost/f"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("TOP SECRET");
  });

  it("returns 404, not 403, when the leaf simply disappears in the window", async () => {
    raceWindow.swap = async (resolved) => {
      if (resolved.endsWith("avatar.txt")) await unlink(SERVED);
    };

    const app = createApp();
    app.get("/f", async (_req, reply) => reply.sendFile("avatar.txt", { root: ROOT }));

    const response = await app.handle(new Request("http://localhost/f"));
    expect(response.status).toBe(404);
  });
});
