// Auth routes — registration, login, and a protected "me" endpoint.
//
// Demonstrates:
//   - JWT token signing via the @celsian/jwt plugin
//   - Route-level hooks (preHandler) for protecting specific routes
//   - HttpError for structured error responses
//   - Password hashing with Node's built-in scrypt

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { PluginFunction } from "@celsian/core";
import { HttpError } from "@celsian/core";
import { z } from "zod";
import { authGuard, getJwt } from "../middleware/auth.js";

const scryptAsync = promisify(scrypt);

// ─── In-Memory User Store ───

interface User {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
}

const users = new Map<string, User>();
let nextUserId = 1;

export function resetUsers() {
  users.clear();
  nextUserId = 1;
}

// ─── Helpers ───

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${salt}:${hash.toString("hex")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(":");
  const hashBuffer = Buffer.from(hash!, "hex");
  const derived = (await scryptAsync(password, salt!, 64)) as Buffer;
  return timingSafeEqual(hashBuffer, derived);
}

function findUserByEmail(email: string): User | undefined {
  for (const user of users.values()) {
    if (user.email === email) return user;
  }
}

// ─── Validation Schemas ───

const authCredentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

// ─── Plugin ───

export const authRoutes: PluginFunction = (app) => {
  // POST /auth/register — Create a new account and return a JWT
  app.post("/auth/register", {
    schema: { body: authCredentialsSchema },
  }, async (req, reply) => {
    const { email, password } = req.parsedBody;

    if (findUserByEmail(email)) {
      throw new HttpError(409, "Email already registered");
    }

    const user: User = {
      id: String(nextUserId++),
      email,
      passwordHash: await hashPassword(password),
      createdAt: new Date().toISOString(),
    };
    users.set(user.id, user);

    const token = await getJwt().sign({ sub: user.id, email }, { expiresIn: "1h" });

    return reply.status(201).json({
      user: { id: user.id, email: user.email },
      token,
    });
  });

  // POST /auth/login — Authenticate and return a JWT
  app.post("/auth/login", {
    schema: { body: authCredentialsSchema },
  }, async (req, reply) => {
    const { email, password } = req.parsedBody;

    const user = findUserByEmail(email);
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw new HttpError(401, "Invalid email or password");
    }

    const token = await getJwt().sign({ sub: user.id, email }, { expiresIn: "1h" });

    return reply.json({
      user: { id: user.id, email: user.email },
      token,
    });
  });

  // GET /auth/me — Protected route: returns the authenticated user's profile
  app.route({
    method: "GET",
    url: "/auth/me",
    preHandler: authGuard,
    handler(req, reply) {
      const payload = (req as Record<string, unknown>).user as { sub: string; email: string };
      const user = users.get(payload.sub);
      if (!user) throw new HttpError(404, "User not found");

      return reply.json({
        id: user.id,
        email: user.email,
        createdAt: user.createdAt,
      });
    },
  });
};
