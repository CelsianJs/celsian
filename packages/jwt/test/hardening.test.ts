// @celsian/jwt, claim verification, expiry policy, forgery rejection, asymmetric keys and JWKS

import { createApp } from "@celsian/core";
import * as jose from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJWTGuard, jwt } from "../src/index.js";

const SECRET = "test-secret-key-for-testing-only-min-32-chars";

function base64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

/** Mount a route behind `guard` and return a helper that injects a bearer token. */
function protectedApp(guard: ReturnType<typeof createJWTGuard>) {
  const app = createApp();
  app.route({
    method: "GET",
    url: "/protected",
    preHandler: guard,
    handler: (req, reply) => reply.json({ user: (req as { user?: unknown }).user }),
  });
  return (token: string) => app.inject({ url: "/protected", headers: { authorization: `Bearer ${token}` } });
}

describe("issuer / audience / subject verification", () => {
  it("rejects a token minted by a different service that reuses the same secret", async () => {
    // The realistic failure: one JWT_SECRET shared across a monolith split or a
    // prod/staging pair. Without iss/aud checks the foreign token authenticates.
    const foreignToken = await new jose.SignJWT({ sub: "attacker", scope: "admin" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .setIssuer("https://some-other-service.example")
      .setAudience("some-other-audience")
      .sign(new TextEncoder().encode(SECRET));

    const inject = protectedApp(createJWTGuard({ secret: SECRET, issuer: "https://api.example.com", audience: "api" }));
    expect((await inject(foreignToken)).status).toBe(401);
  });

  it("accepts a token whose iss/aud match, and sign() sets them from the same config", async () => {
    const realm = jwt({ secret: SECRET, issuer: "https://api.example.com", audience: "api" });
    const token = await realm.sign({ sub: "user-1" });

    const payload = await realm.verify(token);
    expect(payload.iss).toBe("https://api.example.com");
    expect(payload.aud).toBe("api");

    const inject = protectedApp(createJWTGuard({ secret: SECRET, issuer: "https://api.example.com", audience: "api" }));
    expect((await inject(token)).status).toBe(200);
  });

  it("rejects a mismatched subject", async () => {
    const token = await jwt({ secret: SECRET }).sign({ sub: "user-1" });
    expect((await protectedApp(createJWTGuard({ secret: SECRET, subject: "user-2" }))(token)).status).toBe(401);
    expect((await protectedApp(createJWTGuard({ secret: SECRET, subject: "user-1" }))(token)).status).toBe(200);
  });

  it("honors clockTolerance for a token that expired a moment ago", async () => {
    const realm = jwt({ secret: SECRET });
    const token = await realm.sign({ sub: "user-1" }, { expiresIn: -5 });

    expect((await protectedApp(createJWTGuard({ secret: SECRET }))(token)).status).toBe(401);
    expect((await protectedApp(createJWTGuard({ secret: SECRET, clockTolerance: "60s" }))(token)).status).toBe(200);
  });

  it("honors maxTokenAge independently of exp", async () => {
    const oldIat = Math.floor(Date.now() / 1000) - 3600;
    const token = await new jose.SignJWT({ sub: "user-1" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(oldIat)
      .setExpirationTime("10h")
      .sign(new TextEncoder().encode(SECRET));

    expect((await protectedApp(createJWTGuard({ secret: SECRET, maxTokenAge: "5m" }))(token)).status).toBe(401);
    expect((await protectedApp(createJWTGuard({ secret: SECRET, maxTokenAge: "10h" }))(token)).status).toBe(200);
  });
});

describe("expiration policy", () => {
  it("gives sign() a default expiry instead of minting a permanent credential", async () => {
    const payload = await jwt({ secret: SECRET }).verify(await jwt({ secret: SECRET }).sign({ sub: "user-1" }));
    expect(typeof payload.exp).toBe("number");
    expect(payload.exp!).toBeGreaterThan(Math.floor(Date.now() / 1000));
    // The default is 15 minutes, not hours or days.
    expect(payload.exp! - payload.iat!).toBe(15 * 60);
  });

  it("rejects a token with no exp claim by default", async () => {
    const eternal = await new jose.SignJWT({ sub: "forever" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .sign(new TextEncoder().encode(SECRET));

    expect(eternal.split(".").length).toBe(3);
    await expect(jwt({ secret: SECRET }).verify(eternal)).rejects.toThrow(/exp/);
    expect((await protectedApp(createJWTGuard({ secret: SECRET }))(eternal)).status).toBe(401);
  });

  it("allows an exp-less token only when expiration is explicitly opted out of", async () => {
    const realm = jwt({ secret: SECRET, requireExpiration: false, expiresIn: false });
    const token = await realm.sign({ sub: "service-account" });
    expect((await realm.verify(token)).exp).toBeUndefined();
    expect((await protectedApp(realm.guard())(token)).status).toBe(200);
  });

  it("refuses a config that mints tokens it would itself reject", () => {
    expect(() => jwt({ secret: SECRET, expiresIn: false })).toThrow(/requireExpiration/);
  });
});

describe("forgery and malformed tokens fail closed", () => {
  // These were previously console.log-only "proof of concept" checks with no
  // assertions, so an alg:none regression would not have failed the build.
  it("rejects an alg:none token forged from a valid payload", async () => {
    const header = base64url(JSON.stringify({ alg: "none", typ: "JWT" }));
    const body = base64url(JSON.stringify({ sub: "admin", exp: Math.floor(Date.now() / 1000) + 3600 }));
    const forged = `${header}.${body}.`;

    await expect(jwt({ secret: SECRET }).verify(forged)).rejects.toThrow();
    expect((await protectedApp(createJWTGuard({ secret: SECRET }))(forged)).status).toBe(401);
  });

  it("rejects an alg:none token even when the realm is configured with several algorithms", async () => {
    const header = base64url(JSON.stringify({ alg: "none", typ: "JWT" }));
    const body = base64url(JSON.stringify({ sub: "admin", exp: Math.floor(Date.now() / 1000) + 3600 }));
    const guard = createJWTGuard({ secret: SECRET, algorithms: ["HS256", "HS384", "HS512"] });
    expect((await protectedApp(guard)(`${header}.${body}.`)).status).toBe(401);
  });

  it.each([
    ["empty string", ""],
    ["not a JWT", "not-a-jwt"],
    ["two segments", "aaa.bbb"],
    ["four segments", "aaa.bbb.ccc.ddd"],
    ["tampered signature", "REPLACED"],
    ["tampered payload", "REPLACED_PAYLOAD"],
  ])("rejects a malformed token (%s)", async (_label, variant) => {
    const valid = await jwt({ secret: SECRET }).sign({ sub: "user-1" });
    const [h, p, s] = valid.split(".");
    let token = variant;
    if (variant === "REPLACED") token = `${h}.${p}.${"A".repeat(s!.length)}`;
    if (variant === "REPLACED_PAYLOAD") token = `${h}.${base64url(JSON.stringify({ sub: "admin" }))}.${s}`;

    expect((await protectedApp(createJWTGuard({ secret: SECRET }))(token)).status).toBe(401);
  });

  it("rejects a token signed with the right secret but a non-allowed algorithm", async () => {
    const hs512 = await new jose.SignJWT({ sub: "user-1" })
      .setProtectedHeader({ alg: "HS512" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(SECRET));

    expect((await protectedApp(createJWTGuard({ secret: SECRET, algorithms: ["HS256"] }))(hs512)).status).toBe(401);
  });
});

describe("asymmetric keys", () => {
  it("signs and verifies RS256 with a PEM key pair", async () => {
    const { publicKey, privateKey } = await jose.generateKeyPair("RS256", { extractable: true });
    const spki = await jose.exportSPKI(publicKey);
    const pkcs8 = await jose.exportPKCS8(privateKey);

    const realm = jwt({ publicKey: spki, privateKey: pkcs8, algorithms: ["RS256"] });
    const token = await realm.sign({ sub: "rsa-user" });
    expect((await realm.verify(token)).sub).toBe("rsa-user");
    expect((await protectedApp(realm.guard())(token)).status).toBe(200);
  });

  it("verifies ES256 and rejects a token from a different key pair", async () => {
    const a = await jose.generateKeyPair("ES256", { extractable: true });
    const b = await jose.generateKeyPair("ES256", { extractable: true });

    const realmA = jwt({
      publicKey: await jose.exportSPKI(a.publicKey),
      privateKey: await jose.exportPKCS8(a.privateKey),
      algorithms: ["ES256"],
    });
    const realmB = jwt({
      publicKey: await jose.exportSPKI(b.publicKey),
      privateKey: await jose.exportPKCS8(b.privateKey),
      algorithms: ["ES256"],
    });

    const tokenB = await realmB.sign({ sub: "b" });
    expect((await protectedApp(realmA.guard())(tokenB)).status).toBe(401);
    expect((await protectedApp(realmA.guard())(await realmA.sign({ sub: "a" }))).status).toBe(200);
  });

  it("keeps algorithms pinned: an RS256 realm rejects an HS256 token", async () => {
    const { publicKey, privateKey } = await jose.generateKeyPair("RS256", { extractable: true });
    const spki = await jose.exportSPKI(publicKey);
    const realm = jwt({ publicKey: spki, privateKey: await jose.exportPKCS8(privateKey), algorithms: ["RS256"] });

    // Classic key-confusion attempt: sign HS256 using the public key as the HMAC secret.
    const confused = await new jose.SignJWT({ sub: "attacker" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(spki));

    expect((await protectedApp(realm.guard())(confused)).status).toBe(401);
  });

  it("fails loudly when a verify-only realm is asked to sign", async () => {
    const { publicKey } = await jose.generateKeyPair("RS256", { extractable: true });
    const realm = jwt({ publicKey: await jose.exportSPKI(publicKey), algorithms: ["RS256"] });
    await expect(realm.sign({ sub: "x" })).rejects.toThrow(/cannot sign/);
  });
});

describe("configuration guards", () => {
  it("rejects a realm with no key material", () => {
    expect(() => jwt({})).toThrow(/No key material/);
  });

  it("rejects mutually exclusive key material", () => {
    expect(() => jwt({ secret: SECRET, jwksUri: "https://idp.example/.well-known/jwks.json" })).toThrow(
      /mutually exclusive/,
    );
  });

  it("rejects an empty algorithm list rather than leaving the algorithm unpinned", () => {
    expect(() => jwt({ secret: SECRET, algorithms: [] })).toThrow(/non-empty/);
  });
});

describe("JWKS", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses a non-https JWKS URL (no plaintext key fetch, no SSRF-friendly schemes)", () => {
    expect(() => jwt({ jwksUri: "http://idp.example/.well-known/jwks.json" })).toThrow(/https:/);
    expect(() => jwt({ jwksUri: "file:///etc/passwd" })).toThrow(/https:/);
    expect(() => jwt({ jwksUri: "not a url" })).toThrow(/not a valid URL/);
  });

  it("verifies a token via a remote key set, selecting the key by kid and caching the fetch", async () => {
    const first = await jose.generateKeyPair("RS256", { extractable: true });
    const second = await jose.generateKeyPair("RS256", { extractable: true });
    const jwks = {
      keys: [
        { ...(await jose.exportJWK(first.publicKey)), kid: "key-1", alg: "RS256", use: "sig" },
        { ...(await jose.exportJWK(second.publicKey)), kid: "key-2", alg: "RS256", use: "sig" },
      ],
    };

    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify(jwks), { headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const realm = jwt({ jwksUri: "https://idp.example/.well-known/jwks.json", algorithms: ["RS256"] });

    // Signed with the SECOND key, resolution must follow `kid`, not order.
    const token = await new jose.SignJWT({ sub: "idp-user" })
      .setProtectedHeader({ alg: "RS256", kid: "key-2" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(second.privateKey);

    expect((await realm.verify(token)).sub).toBe("idp-user");
    expect((await protectedApp(realm.guard())(token)).status).toBe(200);

    // The key set is cached: repeated verification does not refetch per request.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects a token whose kid is absent from the key set", async () => {
    const known = await jose.generateKeyPair("RS256", { extractable: true });
    const rogue = await jose.generateKeyPair("RS256", { extractable: true });
    const jwks = { keys: [{ ...(await jose.exportJWK(known.publicKey)), kid: "key-1", alg: "RS256", use: "sig" }] };

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(jwks), { headers: { "content-type": "application/json" } })),
    );

    const realm = jwt({ jwksUri: "https://idp.example/.well-known/jwks.json", algorithms: ["RS256"] });
    const forged = await new jose.SignJWT({ sub: "attacker" })
      .setProtectedHeader({ alg: "RS256", kid: "unknown-kid" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(rogue.privateKey);

    expect((await protectedApp(realm.guard())(forged)).status).toBe(401);
  });

  it("does not fetch the key set until a token is actually verified", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ keys: [] })));
    vi.stubGlobal("fetch", fetchSpy);

    jwt({ jwksUri: "https://idp.example/.well-known/jwks.json", algorithms: ["RS256"] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
