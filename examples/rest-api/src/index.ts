import { Type } from "@sinclair/typebox";
import { createApp, serve } from "celsian";

const app = createApp();

const CreateUserSchema = Type.Object({
  name: Type.String(),
  email: Type.String({ format: "email" }),
});

const users: Array<{ id: number; name: string; email: string }> = [];
let nextId = 1;

app.get("/users", (_req, reply) => {
  return reply.json(users);
});

app.post("/users", {
  schema: { body: CreateUserSchema },
}, (req, reply) => {
  const { name, email } = req.parsedBody;
  const user = { id: nextId++, name, email };
  users.push(user);
  return reply.status(201).json(user);
});

app.get("/users/:id", (req, reply) => {
  const user = users.find((u) => u.id === Number(req.params.id));
  if (!user) return reply.status(404).json({ error: "User not found" });
  return reply.json(user);
});

serve(app, { port: 3000 });
