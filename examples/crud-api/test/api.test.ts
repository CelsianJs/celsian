import { beforeEach, describe, expect, it } from "vitest";
import { createCrudApp, resetStore } from "../src/index.js";

describe("CRUD API", () => {
  let app: ReturnType<typeof createCrudApp>;

  beforeEach(async () => {
    resetStore();
    app = createCrudApp();
    await app.ready();
  });

  // ─── CREATE ───

  it("should create a todo", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/todos",
      payload: { title: "Buy groceries", priority: "high" },
    });

    expect(res.status).toBe(201);
    const todo = await res.json();
    expect(todo.title).toBe("Buy groceries");
    expect(todo.priority).toBe("high");
    expect(todo.completed).toBe(false);
    expect(todo.id).toBeDefined();
    expect(todo.createdAt).toBeDefined();
  });

  it("should reject creation without title", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/todos",
      payload: { description: "no title" },
    });
    expect(res.status).toBe(400);
  });

  it("should reject creation with invalid priority", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/todos",
      payload: { title: "Test", priority: "urgent" },
    });
    expect(res.status).toBe(400);
  });

  // ─── READ ───

  it("should get a todo by id", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/todos",
      payload: { title: "Read a book" },
    });
    const created = await createRes.json();

    const res = await app.inject({ url: `/todos/${created.id}` });
    expect(res.status).toBe(200);
    const todo = await res.json();
    expect(todo.title).toBe("Read a book");
  });

  it("should return 404 for missing todo", async () => {
    const res = await app.inject({ url: "/todos/999" });
    expect(res.status).toBe(404);
  });

  // ─── LIST ───

  it("should list todos with pagination", async () => {
    // Create 5 todos
    for (let i = 1; i <= 5; i++) {
      await app.inject({
        method: "POST",
        url: "/todos",
        payload: { title: `Todo ${i}` },
      });
    }

    const res = await app.inject({ url: "/todos?limit=2&page=1" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.pagination.total).toBe(5);
    expect(body.pagination.totalPages).toBe(3);
    expect(body.pagination.page).toBe(1);
  });

  it("should filter todos by completed status", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/todos",
      payload: { title: "Incomplete" },
    });
    const todo = await createRes.json();

    await app.inject({
      method: "PATCH",
      url: `/todos/${todo.id}`,
      payload: { completed: true },
    });

    await app.inject({
      method: "POST",
      url: "/todos",
      payload: { title: "Still open" },
    });

    const completedRes = await app.inject({ url: "/todos?completed=true" });
    const completedBody = await completedRes.json();
    expect(completedBody.data.every((t: { completed: boolean }) => t.completed)).toBe(true);
  });

  it("should search todos by title", async () => {
    await app.inject({ method: "POST", url: "/todos", payload: { title: "Go to the store" } });
    await app.inject({ method: "POST", url: "/todos", payload: { title: "Fix the car" } });
    await app.inject({ method: "POST", url: "/todos", payload: { title: "Store leftovers" } });

    const res = await app.inject({ url: "/todos?search=store" });
    const body = await res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    expect(body.data.every((t: { title: string }) => t.title.toLowerCase().includes("store"))).toBe(true);
  });

  // ─── UPDATE ───

  it("should fully update a todo with PUT", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/todos",
      payload: { title: "Original", priority: "low" },
    });
    const created = await createRes.json();

    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 5));

    const res = await app.inject({
      method: "PUT",
      url: `/todos/${created.id}`,
      payload: { title: "Updated", priority: "high", completed: true },
    });

    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.title).toBe("Updated");
    expect(updated.priority).toBe("high");
    expect(updated.completed).toBe(true);
    expect(updated.updatedAt).toBeDefined();
  });

  it("should partially update a todo with PATCH", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/todos",
      payload: { title: "Patch me", priority: "low" },
    });
    const created = await createRes.json();

    const res = await app.inject({
      method: "PATCH",
      url: `/todos/${created.id}`,
      payload: { completed: true },
    });

    expect(res.status).toBe(200);
    const patched = await res.json();
    expect(patched.title).toBe("Patch me"); // unchanged
    expect(patched.priority).toBe("low"); // unchanged
    expect(patched.completed).toBe(true); // updated
  });

  it("should return 404 when updating non-existent todo", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/todos/999",
      payload: { title: "Nope" },
    });
    expect(res.status).toBe(404);
  });

  // ─── DELETE ───

  it("should delete a todo", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/todos",
      payload: { title: "Delete me" },
    });
    const created = await createRes.json();

    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/todos/${created.id}`,
    });
    expect(deleteRes.status).toBe(204);

    // Verify it's gone
    const getRes = await app.inject({ url: `/todos/${created.id}` });
    expect(getRes.status).toBe(404);
  });

  it("should return 404 when deleting non-existent todo", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/todos/999",
    });
    expect(res.status).toBe(404);
  });

  // ─── HEALTH ───

  it("should respond to health check", async () => {
    const res = await app.inject({ url: "/health" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});
