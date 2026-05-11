// CelsianJS Auth Flow Example
// Demonstrates: JWT auth, refresh tokens, rate limiting, password hashing

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { cors, createApp, HttpError, serve } from "@celsian/core";
import { createJWTGuard, type JWTNamespace, jwt } from "@celsian/jwt";
import { rateLimit } from "@celsian/rate-limit";
import { z } from "zod";

const scryptAsync = promisify(scrypt);

// ─── Config ───
const DEFAULT_JWT_SECRET = "dev-secret-change-in-production";
const JWT_SECRET = process.env.JWT_SECRET ?? DEFAULT_JWT_SECRET;

if (process.env.NODE_ENV === "production" && JWT_SECRET === DEFAULT_JWT_SECRET) {
  throw new Error("Set JWT_SECRET to a strong, unique secret before running auth-flow in production");
}
const ACCESS_TOKEN_EXPIRY = "15m";
const _REFRESH_TOKEN_EXPIRY = "7d";

// ─── In-Memory Stores (replace with database in production) ───
interface User {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
}

const users = new Map<string, User>();
const refreshTokens = new Map<string, { userId: string; expiresAt: number }>();

// ─── Password Hashing ───
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${salt}:${hash.toString("hex")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(":");
  const hashBuffer = Buffer.from(hash!, "hex");
  const derivedKey = (await scryptAsync(password, salt!, 64)) as Buffer;
  return timingSafeEqual(hashBuffer, derivedKey);
}

function generateId(): string {
  return randomBytes(12).toString("hex");
}

// ─── App Setup ───
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:3000";

export function createAuthApp() {
  const app = createApp({ logger: true });

  // Register plugins (security headers are enabled by default)
  app.register(cors({ origin: CORS_ORIGIN }), { encapsulate: false });
  app.register(jwt({ secret: JWT_SECRET }), { encapsulate: false });
  app.register(
    rateLimit({ max: 100, window: 60_000, keyGenerator: (req) => req.headers.get("x-forwarded-for") ?? "local" }),
    { encapsulate: false },
  );

  app.health();

  const jwtGuard = createJWTGuard({ secret: JWT_SECRET });

  // ─── Validation Schemas ───

  const CredentialsSchema = z.object({
    email: z.string().email(),
    password: z.string().min(8, "Password must be at least 8 characters"),
  });

  const RefreshTokenSchema = z.object({
    refreshToken: z.string().min(1),
  });

  // ─── Public Routes ───

  app.post(
    "/auth/register",
    {
      schema: { body: CredentialsSchema },
    },
    async (req, reply) => {
      const { email, password } = req.parsedBody;

      // Check duplicate
      for (const user of users.values()) {
        if (user.email === email) {
          throw new HttpError(409, "Email already registered");
        }
      }

      const user: User = {
        id: generateId(),
        email,
        passwordHash: await hashPassword(password),
        createdAt: new Date().toISOString(),
      };
      users.set(user.id, user);

      const jwtNs = app.getDecoration("jwt") as JWTNamespace;
      const accessToken = await jwtNs.sign({ sub: user.id, email }, { expiresIn: ACCESS_TOKEN_EXPIRY });
      const refreshToken = generateId();
      refreshTokens.set(refreshToken, {
        userId: user.id,
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      });

      return reply.status(201).json({
        user: { id: user.id, email: user.email },
        accessToken,
        refreshToken,
      });
    },
  );

  app.post(
    "/auth/login",
    {
      schema: { body: CredentialsSchema },
    },
    async (req, reply) => {
      const { email, password } = req.parsedBody;

      let foundUser: User | undefined;
      for (const user of users.values()) {
        if (user.email === email) {
          foundUser = user;
          break;
        }
      }

      if (!foundUser || !(await verifyPassword(password, foundUser.passwordHash))) {
        throw new HttpError(401, "Invalid email or password");
      }

      const jwtNs = app.getDecoration("jwt") as JWTNamespace;
      const accessToken = await jwtNs.sign({ sub: foundUser.id, email }, { expiresIn: ACCESS_TOKEN_EXPIRY });
      const refreshToken = generateId();
      refreshTokens.set(refreshToken, {
        userId: foundUser.id,
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      });

      return reply.json({
        user: { id: foundUser.id, email: foundUser.email },
        accessToken,
        refreshToken,
      });
    },
  );

  app.post(
    "/auth/refresh",
    {
      schema: { body: RefreshTokenSchema },
    },
    async (req, reply) => {
      const { refreshToken } = req.parsedBody;

      const stored = refreshTokens.get(refreshToken);
      if (!stored || stored.expiresAt < Date.now()) {
        if (stored) refreshTokens.delete(refreshToken);
        throw new HttpError(401, "Invalid or expired refresh token");
      }

      const user = users.get(stored.userId);
      if (!user) {
        refreshTokens.delete(refreshToken);
        throw new HttpError(401, "User not found");
      }

      // Rotate refresh token
      refreshTokens.delete(refreshToken);
      const newRefreshToken = generateId();
      refreshTokens.set(newRefreshToken, {
        userId: user.id,
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      });

      const jwtNs = app.getDecoration("jwt") as JWTNamespace;
      const accessToken = await jwtNs.sign({ sub: user.id, email: user.email }, { expiresIn: ACCESS_TOKEN_EXPIRY });

      return reply.json({
        accessToken,
        refreshToken: newRefreshToken,
      });
    },
  );

  app.post(
    "/auth/logout",
    {
      schema: { body: RefreshTokenSchema },
    },
    async (req, reply) => {
      const { refreshToken } = req.parsedBody;
      refreshTokens.delete(refreshToken);
      return reply.json({ message: "Logged out" });
    },
  );

  // ─── Protected Routes ───

  app.route({
    method: "GET",
    url: "/auth/me",
    preHandler: jwtGuard,
    handler: async (req, reply) => {
      const payload = (req as Record<string, unknown>).user as { sub: string; email: string };
      const user = users.get(payload.sub);
      if (!user) throw new HttpError(404, "User not found");
      return reply.json({ id: user.id, email: user.email, createdAt: user.createdAt });
    },
  });

  return app;
}

// Start server only when executed directly, not when imported by tests/examples.
const isDirectRun = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === new URL(process.argv[1], `file://${process.cwd()}/`).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  const app = createAuthApp();
  await app.ready();
  await serve(app, { port: parseInt(process.env.PORT ?? "3000", 10) });
}
