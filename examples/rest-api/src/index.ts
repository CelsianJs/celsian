import { Type } from "@sinclair/typebox";
import { createApp, serve } from "celsian";

const app = createApp();

// TypeBox `format` keywords are opt-in: unless the format is registered with
// TypeBox's FormatRegistry, validation fails with "Unknown format 'email'".
// A pattern keeps this example self-contained.
const CreateUserSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  email: Type.String({ pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$" }),
});

const users: Array<{ id: number; name: string; email: string }> = [];
let nextId = 1;

app.get("/users", (_req, reply) => {
  return reply.json(users);
});

app.post(
  "/users",
  {
    schema: { body: CreateUserSchema },
  },
  (req, reply) => {
    const { name, email } = req.parsedBody;
    const user = { id: nextId++, name, email };
    users.push(user);
    return reply.status(201).json(user);
  },
);

app.get("/users/:id", (req, reply) => {
  const user = users.find((u) => u.id === Number(req.params.id));
  if (!user) return reply.status(404).json({ error: "User not found" });
  return reply.json(user);
});

serve(app, { port: parseInt(process.env.PORT ?? "3000", 10) });

// Exported so tooling that loads this file (for example `celsian routes`)
// can find the app. Running the file directly still starts the server above.
export default app;
