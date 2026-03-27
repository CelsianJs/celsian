import { beforeEach, describe, expect, it } from "vitest";
import { buildTodoApp } from "./todo-api.js";

describe("Todo REST API", () => {
  let app: ReturnType<typeof buildTodoApp>;

  beforeEach(() => {
    app = buildTodoApp();
  });

  // ─── GET /todos ───

  it("returns empty array initially", async () => {
    const res = await app.inject({ url: "/todos" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  // ─── POST /todos ───

  it("creates a todo with 201 status", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/todos",
      payload: { title: "Buy milk" },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      id: 1,
      title: "Buy milk",
      completed: false,
    });
    expect(body.createdAt).toBeDefined();
  });

  it("rejects POST with missing title", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/todos",
      payload: {},
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("BAD_REQUEST");
  });

  it("rejects POST with empty title", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/todos",
      payload: { title: "   " },
    });
    expect(res.status).toBe(400);
  });

  // ─── GET /todos/:id ───

  it("retrieves a created todo by ID", async () => {
    await app.inject({ method: "POST", url: "/todos", payload: { title: "Test" } });

    const res = await app.inject({ url: "/todos/1" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe("Test");
  });

  it("returns 404 for non-existent todo", async () => {
    const res = await app.inject({ url: "/todos/999" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns 400 for invalid ID format", async () => {
    const res = await app.inject({ url: "/todos/abc" });
    expect(res.status).toBe(400);
  });

  // ─── PUT /todos/:id ───

  it("updates a todo title", async () => {
    await app.inject({ method: "POST", url: "/todos", payload: { title: "Old" } });

    const res = await app.inject({
      method: "PUT",
      url: "/todos/1",
      payload: { title: "New" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe("New");
  });

  it("marks a todo as completed", async () => {
    await app.inject({ method: "POST", url: "/todos", payload: { title: "Task" } });

    const res = await app.inject({
      method: "PUT",
      url: "/todos/1",
      payload: { completed: true },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).completed).toBe(true);
  });

  it("returns 404 when updating non-existent todo", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/todos/999",
      payload: { title: "Nope" },
    });
    expect(res.status).toBe(404);
  });

  it("rejects update with invalid completed type", async () => {
    await app.inject({ method: "POST", url: "/todos", payload: { title: "Task" } });

    const res = await app.inject({
      method: "PUT",
      url: "/todos/1",
      payload: { completed: "yes" },
    });
    expect(res.status).toBe(400);
  });

  // ─── DELETE /todos/:id ───

  it("deletes a todo with 204", async () => {
    await app.inject({ method: "POST", url: "/todos", payload: { title: "Delete me" } });

    const res = await app.inject({ method: "DELETE", url: "/todos/1" });
    expect(res.status).toBe(204);

    // Verify it is gone
    const getRes = await app.inject({ url: "/todos/1" });
    expect(getRes.status).toBe(404);
  });

  it("returns 404 when deleting non-existent todo", async () => {
    const res = await app.inject({ method: "DELETE", url: "/todos/999" });
    expect(res.status).toBe(404);
  });

  // ─── Integration: list reflects mutations ───

  it("list reflects created and deleted todos", async () => {
    await app.inject({ method: "POST", url: "/todos", payload: { title: "A" } });
    await app.inject({ method: "POST", url: "/todos", payload: { title: "B" } });
    await app.inject({ method: "POST", url: "/todos", payload: { title: "C" } });

    let list = await (await app.inject({ url: "/todos" })).json();
    expect(list).toHaveLength(3);

    await app.inject({ method: "DELETE", url: "/todos/2" });

    list = await (await app.inject({ url: "/todos" })).json();
    expect(list).toHaveLength(2);
    expect(list.map((t: { title: string }) => t.title)).toEqual(["A", "C"]);
  });
});
