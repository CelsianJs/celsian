// @celsian/core -- regression tests for the reply/serve/cookie/upload hardening pass
//
// Every case here was reproduced against the unfixed code before the fix landed.
// Control-character and Unicode-whitespace payloads are built with
// String.fromCharCode rather than written literally. Being invisible is the
// whole point of these payloads, and a raw tab or U+2028 in the source makes
// this file unreadable to line-oriented tooling and unreviewable in a diff.

import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { resetCookieSecurityWarnings, serializeCookie } from "../src/cookie.js";
import { type UploadedFile, upload } from "../src/plugins/upload.js";
import { serve } from "../src/serve.js";

const TMP_DIR = join(import.meta.dirname ?? ".", "__tmp_workstream_c__");
const STATIC_DIR = join(TMP_DIR, "public");
const SECRET_FILE = join(TMP_DIR, "secret.env");

beforeAll(async () => {
  await mkdir(STATIC_DIR, { recursive: true });
  await writeFile(SECRET_FILE, "DATABASE_URL=postgres://root:hunter2@db/prod");
  await writeFile(join(STATIC_DIR, "real.txt"), "public asset");
  // The exploit: a symlink planted inside the served root, pointing out of it.
  await symlink(SECRET_FILE, join(STATIC_DIR, "avatar.png"));
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

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

describe("[HIGH-1] reply.redirect() rejects tab/newline open redirects", () => {
  // new URL("/\t/evil.com", "https://victim/go") === "https://evil.com/", because
  // the URL parser deletes tab and newline BEFORE parsing. A startsWith("//")
  // check on the raw string therefore never sees the protocol-relative URL the
  // browser will actually navigate to.
  const TAB = String.fromCharCode(0x09);
  const LF = String.fromCharCode(0x0a);
  const CR = String.fromCharCode(0x0d);

  const payloads: [string, string][] = [
    ["tab after the first slash", `/${TAB}/evil.com`],
    ["tab before the first slash", `${TAB}//evil.com`],
    ["newline splitting the slashes", `/${LF}/evil.com`],
    ["carriage return splitting the slashes", `/${CR}/evil.com`],
    ["tab plus backslash", `/${TAB}\\evil.com`],
    ["tab inside the scheme", `ht${TAB}tps://evil.com`],
  ];

  for (const [label, payload] of payloads) {
    it(`rejects ${label}`, async () => {
      const app = createApp();
      app.get("/go", (_req, reply) => reply.redirect(payload));

      const res = await app.handle(new Request("http://localhost/go"));
      expect(res.status).toBe(400);
      // Nothing navigable may leak into Location.
      expect(res.headers.get("location")).toBeNull();
    });
  }

  it("proves the payload really is an open redirect once a browser parses it", () => {
    expect(new URL(`/${TAB}/evil.com`, "https://victim.example.com/go").host).toBe("evil.com");
  });

  it("still allows ordinary relative redirects", async () => {
    const app = createApp();
    app.get("/go", (_req, reply) => reply.redirect("/dashboard?next=1"));

    const res = await app.handle(new Request("http://localhost/go"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard?next=1");
  });
});

describe("[LOW] reply.redirect() returns 400, never an uncaught 500, on control chars", () => {
  it("rejects a NUL byte with a 400 instead of a Headers TypeError", async () => {
    const app = createApp();
    app.get("/go", (_req, reply) => reply.redirect(`/safe${String.fromCharCode(0)}path`));

    const res = await app.handle(new Request("http://localhost/go"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("INVALID_REDIRECT");
  });
});

describe("[LOW] reply.download() handles non-Latin-1 filenames", () => {
  // Beyond Latin-1 on purpose: a header value is Latin-1 at best, so undici
  // accepts "rapport-\u00e9t\u00e9.txt" but throws a TypeError on this one,
  // and the bare catch reported that as 404 for a file it had just read.
  const NON_LATIN1_NAME = `${String.fromCharCode(0x5831, 0x544a, 0x66f8)}.txt`;

  it("does not report 404 for a file that exists, and emits RFC 6266 filename*", async () => {
    const app = createApp();
    app.get("/dl", async (_req, reply) =>
      reply.download(join(STATIC_DIR, "real.txt"), { root: STATIC_DIR, filename: NON_LATIN1_NAME }),
    );

    const res = await app.handle(new Request("http://localhost/dl"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("public asset");

    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("filename*=UTF-8''%E5%A0%B1%E5%91%8A%E6%9B%B8.txt");
    // The ASCII fallback must still be a usable, quote-safe name.
    expect(disposition).toContain('filename="___.txt"');
  });

  it("basenames a caller-supplied filename", async () => {
    const app = createApp();
    app.get("/dl", async (_req, reply) =>
      reply.download(join(STATIC_DIR, "real.txt"), { root: STATIC_DIR, filename: "../../etc/passwd" }),
    );

    const res = await app.handle(new Request("http://localhost/dl"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="passwd"');
  });
});

describe("[HIGH-2] serve({ staticDir }) does not follow symlinks out of the root", () => {
  it("refuses a symlinked file pointing outside staticDir", async () => {
    const app = createApp();
    app.get("/ok", (_req, reply) => reply.json({ ok: true }));

    const port = await freePort();
    const { close } = await serve(app, { port, host: "127.0.0.1", staticDir: STATIC_DIR });

    try {
      const res = await fetch(`http://127.0.0.1:${port}/avatar.png`);
      const body = await res.text();
      expect(body).not.toContain("hunter2");
      expect(res.status).not.toBe(200);

      // A genuine asset inside the root is still served.
      const good = await fetch(`http://127.0.0.1:${port}/real.txt`);
      expect(good.status).toBe(200);
      expect(await good.text()).toBe("public asset");

      // And the app handler still works.
      const ok = await fetch(`http://127.0.0.1:${port}/ok`);
      expect(ok.status).toBe(200);
    } finally {
      await close();
    }
  });
});

describe("[HIGH-3] sanitizeFileName() cannot escape the upload directory", () => {
  /** Round-trip a multipart upload and return the sanitized names. */
  async function uploadNames(fileNames: string[]): Promise<string[]> {
    const app = createApp();
    app.register(upload());
    app.post("/u", (req) => ({
      names: ((req as unknown as { files: UploadedFile[] }).files ?? []).map((f) => f.fileName),
    }));

    const form = new FormData();
    for (const [i, name] of fileNames.entries()) {
      form.append(`f${i}`, new File(["x"], name, { type: "text/plain" }));
    }
    const res = await app.handle(new Request("http://localhost/u", { method: "POST", body: form }));
    expect(res.status).toBe(200);
    return ((await res.json()) as { names: string[] }).names;
  }

  const NBSP = String.fromCharCode(0x00a0);
  const LINE_SEP = String.fromCharCode(0x2028);
  const BOM = String.fromCharCode(0xfeff);

  const escapes: [string, string][] = [
    ["plain dotdot", ".."],
    ["single dot", "."],
    ["space then dotdot", " .."],
    ["NBSP then dotdot", `${NBSP}..`],
    ["U+2028 then dotdot", `${LINE_SEP}..`],
    ["BOM then dotdot", `${BOM}..`],
    ["dotdot then trailing space", ".. "],
    ["interleaved dots and spaces", " . . "],
  ];

  for (const [label, raw] of escapes) {
    it(`never returns "." or ".." for ${label}`, async () => {
      const [name] = await uploadNames([raw]);
      expect(name).toBeDefined();
      expect(name).not.toBe("..");
      expect(name).not.toBe(".");
      expect(name).not.toBe("");
      // The real contract: joining it onto a directory stays inside it.
      expect(join("/srv/uploads", name as string).startsWith("/srv/uploads/")).toBe(true);
    });
  }

  it("strips leading dots that whitespace was shielding", async () => {
    const [name] = await uploadNames([" .env"]);
    expect(name).toBe("env");
  });

  it("strips trailing dots Windows would silently remove", async () => {
    const [name] = await uploadNames(["evil.php."]);
    expect(name).toBe("evil.php");
  });

  it("defuses Windows reserved device names", async () => {
    const names = await uploadNames(["CON", "nul.txt", "COM1.png", "lpt9"]);
    expect(names).toEqual(["file_CON", "file_nul.txt", "file_COM1.png", "file_lpt9"]);
  });

  it("leaves ordinary names alone", async () => {
    const names = await uploadNames(["report.pdf", "my photo (1).jpeg", "console.log.txt"]);
    expect(names).toEqual(["report.pdf", "my photo (1).jpeg", "console.log.txt"]);
  });
});

describe("[MEDIUM-1] the insecure-host warn set is bounded", () => {
  it("stops warning after a fixed number of distinct client-supplied hosts", () => {
    resetCookieSecurityWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let i = 0; i < 5_000; i++) {
        serializeCookie("sid", "v", {}, { headers: new Headers({ host: `spoof-${i}.example.com` }) });
      }
      // Unbounded: 5000 warnings and 5000 retained strings. Bounded: at most the
      // per-host warnings plus a single suppression notice.
      expect(warn.mock.calls.length).toBeLessThanOrEqual(65);
      expect(warn.mock.calls.length).toBeGreaterThan(1);
      expect(String(warn.mock.calls.at(-1)?.[0])).toContain("further per-host warnings are suppressed");
    } finally {
      warn.mockRestore();
      resetCookieSecurityWarnings();
    }
  });

  it("still warns, and still sets Secure, for the first hosts seen", () => {
    resetCookieSecurityWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const cookie = serializeCookie("sid", "v", {}, { headers: new Headers({ host: "app.example.com" }) });
      expect(cookie).toContain("; Secure");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      resetCookieSecurityWarnings();
    }
  });
});
