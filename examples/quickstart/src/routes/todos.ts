// Todo CRUD routes — registered as an encapsulated plugin with a /todos prefix.
//
// Demonstrates:
//   - Route shorthand methods (get, post, put, delete)
//   - Schema validation with Zod (auto-detected by @celsian/schema)
//   - Reply helpers (json, notFound, status)
//   - In-memory data store (swap for a real DB in production)

import type { PluginFunction } from "@celsian/core";
import { z } from "zod";

// ─── Types ───

interface Todo {
  id: string;
  title: string;
  completed: boolean;
  createdAt: string;
}

// ─── In-Memory Store ───
// Exported so tests can inspect state if needed.

let nextId = 1;
const todos = new Map<string, Todo>();

export function resetTodos() {
  nextId = 1;
  todos.clear();
}

// ─── Validation Schemas ───

const createTodoSchema = z.object({
  title: z.string().min(1, "Title is required").max(200),
  completed: z.boolean().optional().default(false),
});

const updateTodoSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  completed: z.boolean().optional(),
});

// ─── Plugin ───

export const todoRoutes: PluginFunction = (app) => {
  // GET /todos — List all todos
  app.get("/todos", (_req, reply) => {
    const list = Array.from(todos.values());
    return reply.json(list);
  });

  // GET /todos/:id — Get a single todo
  app.get("/todos/:id", (req, reply) => {
    const todo = todos.get(req.params.id);
    if (!todo) return reply.notFound("Todo not found");
    return reply.json(todo);
  });

  // POST /todos — Create a new todo (with schema validation)
  app.route({
    method: "POST",
    url: "/todos",
    schema: { body: createTodoSchema },
    handler(req, reply) {
      const { title, completed } = req.parsedBody as z.infer<typeof createTodoSchema>;

      const todo: Todo = {
        id: String(nextId++),
        title,
        completed: completed ?? false,
        createdAt: new Date().toISOString(),
      };
      todos.set(todo.id, todo);

      return reply.status(201).json(todo);
    },
  });

  // PUT /todos/:id — Update a todo (with schema validation)
  app.route({
    method: "PUT",
    url: "/todos/:id",
    schema: { body: updateTodoSchema },
    handler(req, reply) {
      const todo = todos.get(req.params.id);
      if (!todo) return reply.notFound("Todo not found");

      const updates = req.parsedBody as z.infer<typeof updateTodoSchema>;
      if (updates.title !== undefined) todo.title = updates.title;
      if (updates.completed !== undefined) todo.completed = updates.completed;

      return reply.json(todo);
    },
  });

  // DELETE /todos/:id — Delete a todo (204 No Content)
  app.delete("/todos/:id", (req, reply) => {
    const existed = todos.delete(req.params.id);
    if (!existed) return reply.notFound("Todo not found");
    return reply.status(204).send(null);
  });
};
