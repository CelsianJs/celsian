// @celsian/create-celsian -- generated app documentation and auth over real HTTP

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { json } from "../../core/test/helpers/json.js";

type Spec = {
  components: { securitySchemes: Record<string, unknown> };
  security?: unknown;
  paths: Record<string, Record<string, { security?: unknown; parameters?: unknown[] }>>;
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
let scratch: string;
let child: ChildProcess;
let base: string;
let cookie: string;
let csrf: string;
let token: string;

beforeAll(async () => {
  scratch = mkdtempSync(join(ROOT, ".tmp-template-auth-"));
  execFileSync(
    join(ROOT, "node_modules/.bin/tsx"),
    [join(ROOT, "packages/create-celsian/src/index.ts"), "app", "--template", "full"],
    { cwd: scratch },
  );
  const project = join(scratch, "app");
  // Resolve workspace builds instead of installing released packages. Generated
  // sources and runtime security configuration remain entirely unchanged.
  mkdirSync(join(project, "node_modules/@celsian"), { recursive: true });
  symlinkSync(join(ROOT, "packages/celsian"), join(project, "node_modules/celsian"));
  for (const name of ["core", "jwt", "rpc", "rate-limit"]) {
    symlinkSync(join(ROOT, "packages", name), join(project, "node_modules/@celsian", name));
  }
  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: project,
    env: { ...process.env, NODE_ENV: "development", PORT: "0", HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolveReady, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`Generated app did not start: ${output}`)), 20_000);
    const onData = (data: Buffer) => {
      output += data.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match && match[1] !== "0") {
        base = match[0];
        clearTimeout(timeout);
        resolveReady();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Generated app exited (${code}): ${output}`));
    });
  });
  const login = await fetch(`${base}/auth/token`);
  expect(login.status).toBe(200);
  token = (await json<{ token: string }>(login)).token;
  const users = await fetch(`${base}/users`);
  const setCookie = users.headers.getSetCookie().find((value) => value.startsWith("_csrf="));
  if (!setCookie) throw new Error("GET /users did not issue the documented CSRF cookie");
  cookie = setCookie.split(";")[0];
  csrf = decodeURIComponent(cookie.slice("_csrf=".length));
}, 30_000);

afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    child.kill("SIGTERM");
    await exited;
  }
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("full scaffold auth documentation matches HTTP enforcement", () => {
  it("documents Bearer auth only on protected routes and CSRF on every users mutation", async () => {
    const response = await fetch(`${base}/docs/openapi.json`);
    expect(response.status).toBe(200);
    const spec = await json<Spec>(response);
    expect(spec.components.securitySchemes.bearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT",
    });
    expect(spec.security).toBeUndefined();
    for (const path of ["/health", "/auth/token", "/users", "/users/{id}"]) {
      expect(spec.paths[path].get.security).toBeUndefined();
    }
    expect(spec.paths["/users"].post.security).toBeUndefined();
    for (const method of ["put", "delete"]) {
      expect(spec.paths["/users/{id}"][method].security).toEqual([{ bearerAuth: [] }]);
    }
    for (const operation of [
      spec.paths["/users"].post,
      spec.paths["/users/{id}"].put,
      spec.paths["/users/{id}"].delete,
    ]) {
      expect(operation.parameters).toContainEqual(
        expect.objectContaining({
          name: "x-csrf-token",
          in: "header",
          required: true,
          description: expect.stringContaining("_csrf"),
          schema: { type: "string" },
        }),
      );
    }
  });

  it("requires both JWT and genuine matching CSRF tokens, then allows create/update/delete", async () => {
    const request = (method: string, path: string, headers: Record<string, string>, body?: object) =>
      fetch(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json", ...headers },
        body: body && JSON.stringify(body),
      });
    const csrfHeaders = { cookie, "x-csrf-token": csrf };
    const headers = { ...csrfHeaders, authorization: `Bearer ${token}` };
    const payload = { name: "Docs user", email: "docs@example.com" };
    expect((await request("POST", "/users", {}, payload)).status).toBe(403);
    expect((await request("POST", "/users", { cookie, "x-csrf-token": "wrong" }, payload)).status).toBe(403);
    const created = await request("POST", "/users", csrfHeaders, { name: "Docs user", email: "docs@example.com" });
    expect(created.status).toBe(201);
    const user = await json<{ id: string }>(created);
    const path = `/users/${user.id}`;
    for (const method of ["PUT", "DELETE"]) {
      const body = method === "PUT" ? { name: "Updated through docs" } : undefined;
      expect((await request(method, path, csrfHeaders, body)).status).toBe(401);
      expect((await request(method, path, { ...csrfHeaders, authorization: "Bearer invalid" }, body)).status).toBe(401);
      expect((await request(method, path, { authorization: headers.authorization, cookie }, body)).status).toBe(403);
      expect(
        (await request(method, path, { authorization: headers.authorization, "x-csrf-token": csrf }, body)).status,
      ).toBe(403);
      expect((await request(method, path, { ...headers, "x-csrf-token": "wrong" }, body)).status).toBe(403);
      expect(
        (await request(method, path, { ...headers, cookie: "_csrf=forged", "x-csrf-token": "forged" }, body)).status,
      ).toBe(403);
    }
    const updated = await request("PUT", path, headers, { name: "Updated through docs" });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ id: user.id, name: "Updated through docs" });
    expect((await request("DELETE", path, headers)).status).toBe(204);
    expect((await fetch(`${base}${path}`)).status).toBe(404);
  });
});
