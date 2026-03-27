// Real-world test: Full CRUD Todo REST API

import type { CelsianApp } from "../packages/core/src/app.js";
import { createApp } from "../packages/core/src/app.js";

interface Todo {
  id: number;
  title: string;
  completed: boolean;
  createdAt: string;
}

export function buildTodoApp(): CelsianApp {
  const app = createApp();

  // In-memory store
  let nextId = 1;
  const todos = new Map<number, Todo>();

  // GET /todos — list all
  app.get("/todos", (_req, reply) => {
    return reply.json(Array.from(todos.values()));
  });

  // GET /todos/:id — get one
  app.get("/todos/:id", (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return reply.badRequest("Invalid todo ID");
    }
    const todo = todos.get(id);
    if (!todo) {
      return reply.notFound(`Todo ${id} not found`);
    }
    return reply.json(todo);
  });

  // POST /todos — create
  app.post("/todos", (req, reply) => {
    const body = req.parsedBody as { title?: string } | undefined;
    if (!body || typeof body.title !== "string" || !body.title.trim()) {
      return reply.badRequest("Title is required and must be a non-empty string");
    }

    const todo: Todo = {
      id: nextId++,
      title: body.title.trim(),
      completed: false,
      createdAt: new Date().toISOString(),
    };
    todos.set(todo.id, todo);
    return reply.status(201).json(todo);
  });

  // PUT /todos/:id — update
  app.put("/todos/:id", (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return reply.badRequest("Invalid todo ID");
    }
    const existing = todos.get(id);
    if (!existing) {
      return reply.notFound(`Todo ${id} not found`);
    }

    const body = req.parsedBody as { title?: string; completed?: boolean } | undefined;
    if (!body) {
      return reply.badRequest("Request body is required");
    }

    if (body.title !== undefined) {
      if (typeof body.title !== "string" || !body.title.trim()) {
        return reply.badRequest("Title must be a non-empty string");
      }
      existing.title = body.title.trim();
    }
    if (body.completed !== undefined) {
      if (typeof body.completed !== "boolean") {
        return reply.badRequest("Completed must be a boolean");
      }
      existing.completed = body.completed;
    }

    return reply.json(existing);
  });

  // DELETE /todos/:id — delete
  app.delete("/todos/:id", (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return reply.badRequest("Invalid todo ID");
    }
    if (!todos.has(id)) {
      return reply.notFound(`Todo ${id} not found`);
    }
    todos.delete(id);
    // Note: reply.status(204).send(null) fails because send(null) JSON-stringifies
    // to "null" which is a body — 204 No Content rejects bodies in the Response constructor.
    // Workaround: return a raw Response directly.
    return new Response(null, { status: 204 });
  });

  return app;
}
