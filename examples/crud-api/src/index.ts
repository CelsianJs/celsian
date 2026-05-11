// CelsianJS CRUD API Example
// Full CRUD for a "todos" resource with validation, pagination, sorting, and filtering

import { cors, createApp, HttpError, serve } from "@celsian/core";

// ─── Types ───

interface Todo {
  id: string;
  title: string;
  description: string;
  completed: boolean;
  priority: "low" | "medium" | "high";
  createdAt: string;
  updatedAt: string;
}

type SortField = "createdAt" | "updatedAt" | "title" | "priority";
type SortOrder = "asc" | "desc";

// ─── In-Memory Store ───

let nextId = 1;
const todos = new Map<string, Todo>();

/** Reset store (for testing) */
export function resetStore(): void {
  nextId = 1;
  todos.clear();
}

function generateId(): string {
  return String(nextId++);
}

// ─── Validation ───

function validateTodoInput(body: unknown): {
  title: string;
  description?: string;
  priority?: string;
  completed?: boolean;
} {
  if (!body || typeof body !== "object") {
    throw new HttpError(400, "Request body must be a JSON object");
  }
  const { title, description, priority, completed } = body as Record<string, unknown>;

  if (!title || typeof title !== "string" || title.trim().length === 0) {
    throw new HttpError(400, "Title is required and must be a non-empty string");
  }
  if (title.length > 200) {
    throw new HttpError(400, "Title must be 200 characters or less");
  }
  if (description !== undefined && typeof description !== "string") {
    throw new HttpError(400, "Description must be a string");
  }
  if (priority !== undefined && !["low", "medium", "high"].includes(priority as string)) {
    throw new HttpError(400, 'Priority must be "low", "medium", or "high"');
  }
  if (completed !== undefined && typeof completed !== "boolean") {
    throw new HttpError(400, "Completed must be a boolean");
  }
  return {
    title: title.trim(),
    description: description as string | undefined,
    priority: priority as string | undefined,
    completed: completed as boolean | undefined,
  };
}

// ─── Priority ordering for sort ───

const PRIORITY_ORDER: Record<string, number> = { low: 0, medium: 1, high: 2 };

function compareTodos(a: Todo, b: Todo, field: SortField, order: SortOrder): number {
  let cmp: number;
  if (field === "priority") {
    cmp = PRIORITY_ORDER[a.priority]! - PRIORITY_ORDER[b.priority]!;
  } else if (field === "title") {
    cmp = a.title.localeCompare(b.title);
  } else {
    cmp = a[field].localeCompare(b[field]);
  }
  return order === "desc" ? -cmp : cmp;
}

// ─── App ───

const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:3000";

export function createCrudApp() {
  const app = createApp({ logger: true });

  // Security headers are enabled by default via createApp()
  app.register(cors({ origin: CORS_ORIGIN }), { encapsulate: false });
  app.health();

  // ─── LIST (GET /todos) ───
  app.get("/todos", (req, reply) => {
    let items = [...todos.values()];

    // Filter by completed status
    const completed = req.query.completed;
    if (completed !== undefined) {
      const isCompleted = completed === "true";
      items = items.filter((t) => t.completed === isCompleted);
    }

    // Filter by priority
    const priority = req.query.priority;
    if (priority !== undefined) {
      items = items.filter((t) => t.priority === priority);
    }

    // Search by title
    const search = req.query.search;
    if (search !== undefined && typeof search === "string") {
      const term = search.toLowerCase();
      items = items.filter((t) => t.title.toLowerCase().includes(term));
    }

    // Sort
    const sortField = (req.query.sort as SortField) || "createdAt";
    const sortOrder = (req.query.order as SortOrder) || "desc";
    items.sort((a, b) => compareTodos(a, b, sortField, sortOrder));

    // Pagination
    const page = Math.max(1, parseInt((req.query.page as string) || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) || "20", 10)));
    const total = items.length;
    const start = (page - 1) * limit;
    const paged = items.slice(start, start + limit);

    return reply.json({
      data: paged,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  });

  // ─── GET ONE (GET /todos/:id) ───
  app.get("/todos/:id", (req, reply) => {
    const todo = todos.get(req.params.id);
    if (!todo) {
      throw new HttpError(404, `Todo "${req.params.id}" not found`);
    }
    return reply.json(todo);
  });

  // ─── CREATE (POST /todos) ───
  app.post("/todos", (req, reply) => {
    const input = validateTodoInput(req.parsedBody);
    const now = new Date().toISOString();

    const todo: Todo = {
      id: generateId(),
      title: input.title,
      description: input.description ?? "",
      completed: false,
      priority: (input.priority as Todo["priority"]) ?? "medium",
      createdAt: now,
      updatedAt: now,
    };
    todos.set(todo.id, todo);

    return reply.status(201).json(todo);
  });

  // ─── UPDATE (PUT /todos/:id) ───
  app.put("/todos/:id", (req, reply) => {
    const existing = todos.get(req.params.id);
    if (!existing) {
      throw new HttpError(404, `Todo "${req.params.id}" not found`);
    }

    const input = validateTodoInput(req.parsedBody);
    const updated: Todo = {
      ...existing,
      title: input.title,
      description: input.description ?? existing.description,
      completed: input.completed ?? existing.completed,
      priority: (input.priority as Todo["priority"]) ?? existing.priority,
      updatedAt: new Date().toISOString(),
    };
    todos.set(updated.id, updated);

    return reply.json(updated);
  });

  // ─── PATCH (PATCH /todos/:id) ───
  app.patch("/todos/:id", (req, reply) => {
    const existing = todos.get(req.params.id);
    if (!existing) {
      throw new HttpError(404, `Todo "${req.params.id}" not found`);
    }

    const body = req.parsedBody as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object") {
      throw new HttpError(400, "Request body must be a JSON object");
    }

    const updated: Todo = { ...existing, updatedAt: new Date().toISOString() };

    if ("title" in body) {
      if (typeof body.title !== "string" || body.title.trim().length === 0) {
        throw new HttpError(400, "Title must be a non-empty string");
      }
      updated.title = body.title.trim();
    }
    if ("description" in body) {
      if (typeof body.description !== "string") {
        throw new HttpError(400, "Description must be a string");
      }
      updated.description = body.description;
    }
    if ("completed" in body) {
      if (typeof body.completed !== "boolean") {
        throw new HttpError(400, "Completed must be a boolean");
      }
      updated.completed = body.completed;
    }
    if ("priority" in body) {
      if (!["low", "medium", "high"].includes(body.priority as string)) {
        throw new HttpError(400, 'Priority must be "low", "medium", or "high"');
      }
      updated.priority = body.priority as Todo["priority"];
    }

    todos.set(updated.id, updated);
    return reply.json(updated);
  });

  // ─── DELETE (DELETE /todos/:id) ───
  app.delete("/todos/:id", (req, _reply) => {
    const existing = todos.get(req.params.id);
    if (!existing) {
      throw new HttpError(404, `Todo "${req.params.id}" not found`);
    }
    todos.delete(req.params.id);
    return new Response(null, { status: 204 });
  });

  return app;
}

// Start server only when run directly (not when imported by tests)
if (!process.env.VITEST) {
  const app = createCrudApp();
  await app.ready();
  serve(app, { port: parseInt(process.env.PORT ?? "3000", 10) });
}
