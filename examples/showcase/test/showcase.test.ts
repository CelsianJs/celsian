// Smoke test for the Pulse showcase app.
//
// Importing src/index.ts gives back the configured app without starting a
// server (the entry only calls serve() when run directly), so every surface
// the README advertises can be exercised through app.inject().

import { beforeAll, describe, expect, it } from "vitest";
import app from "../src/index.js";

beforeAll(async () => {
  await app.ready();
});

describe("Pulse showcase", () => {
  it("registers the cron job with a valid 5-field expression", () => {
    // "5m" style shorthand throws at boot, which is how this example
    // shipped broken. Registering at all proves the expression parsed.
    const names = app.getCronJobs().map((job) => job.name);
    expect(names).toContain("cleanup-done-tasks");
  });

  it("serves the health check", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.status).toBe(200);
  });

  it("creates and lists a task over REST", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "Smoke test task", priority: "high" },
    });
    expect(created.status).toBe(201);

    const task = await created.json();
    expect(task.title).toBe("Smoke test task");
    expect(task.status).toBe("todo");

    const list = await app.inject({ method: "GET", url: "/api/tasks" });
    expect(list.status).toBe(200);
    const body = await list.json();
    expect(body.tasks.map((t: { id: string }) => t.id)).toContain(task.id);
  });

  it("returns 404 for an unknown task", async () => {
    const res = await app.inject({ method: "GET", url: "/api/tasks/does-not-exist" });
    expect(res.status).toBe(404);
  });

  it("validates the request body", async () => {
    const res = await app.inject({ method: "POST", url: "/api/tasks", payload: { title: "" } });
    expect(res.status).toBe(400);
  });

  it("registers a user and rejects a duplicate", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "ada@example.com", name: "Ada", password: "secret123" },
    });
    expect(first.status).toBe(201);

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "ada@example.com", name: "Ada", password: "secret123" },
    });
    expect(duplicate.status).toBe(409);
  });

  it("serves RPC procedures under /rpc", async () => {
    const res = await app.inject({ method: "GET", url: "/rpc/tasks.stats" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.total).toBeGreaterThan(0);
  });

  it("rejects /api/me without a session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/me" });
    expect(res.status).toBe(401);
  });
});
