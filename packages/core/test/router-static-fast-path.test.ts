// @celsian/core -- the router's exact-match fast path answers what the full match answers
//
// A request whose path is, character for character, a registered static route
// is now matched with one map lookup: no canonicalization, no split, no tree
// walk. Canonicalization itself no longer splits a path that has no "/." in
// it. Neither may change which route a path reaches, least of all for the
// aliased spellings ("//admin", "/./admin", "/admin/") the router exists to
// reject or fold. Every expectation here also holds on the previous router.

import { describe, expect, it } from "vitest";
import { Router } from "../src/router.js";
import type { RouteMethod } from "../src/types.js";

const handler = () => new Response("ok");

function build(options?: ConstructorParameters<typeof Router>[0]): Router {
  const router = new Router(options);
  router.addRoute("GET", "/", handler);
  router.addRoute("GET", "/json", handler);
  router.addRoute("POST", "/json", handler);
  router.addRoute("GET", "/users/me", handler);
  router.addRoute("GET", "/users/:id", handler);
  router.addRoute("DELETE", "/users/:id", handler);
  router.addRoute("GET", "/users/:id/posts/:postId", handler);
  router.addRoute("GET", "/files/*path", handler);
  router.addRoute("GET", "/.well-known/security.txt", handler);
  router.addRoute("GET", "/assets/app.min.js", handler);
  router.addRoute("GET", "/trailing/", handler);
  // Registered with dot segments: never reachable, because the request path is rejected first.
  router.addRoute("GET", "/a/./b", handler);
  router.addRoute("GET", "/a/../c", handler);
  return router;
}

/** `METHOD url-of-the-matched-route {params}`, or null. */
function matched(router: Router, method: RouteMethod, path: string): string | null {
  const match = router.match(method, path);
  if (match === null) return null;
  return `${match.route.method} ${match.route.url} ${JSON.stringify(match.params)}`;
}

describe("Router.match, exact static paths and their aliases", () => {
  const router = build();

  it.each([
    ["GET", "/", "GET / {}"],
    ["GET", "", "GET / {}"],
    ["GET", "/json", "GET /json {}"],
    ["POST", "/json", "POST /json {}"],
    ["GET", "/users/me", "GET /users/me {}"],
    ["GET", "/.well-known/security.txt", "GET /.well-known/security.txt {}"],
    ["GET", "/assets/app.min.js", "GET /assets/app.min.js {}"],
    ["GET", "/trailing", "GET /trailing/ {}"],
    ["GET", "/trailing/", "GET /trailing/ {}"],
    // A trailing slash folds onto the static route.
    ["GET", "/json/", "GET /json {}"],
    ["GET", "/users/me/", "GET /users/me {}"],
    // Another method on a static path falls through to the param route that also covers it.
    ["DELETE", "/users/me", 'DELETE /users/:id {"id":"me"}'],
    ["GET", "/users/42", 'GET /users/:id {"id":"42"}'],
    ["GET", "/users/42/", 'GET /users/:id {"id":"42"}'],
    ["GET", "/users/42/posts/7", 'GET /users/:id/posts/:postId {"id":"42","postId":"7"}'],
    ["GET", "/users/a%20b", 'GET /users/:id {"id":"a b"}'],
    ["GET", "/users/.hidden", 'GET /users/:id {"id":".hidden"}'],
    ["GET", "/users/...", 'GET /users/:id {"id":"..."}'],
    ["GET", "/users/a.b", 'GET /users/:id {"id":"a.b"}'],
    ["GET", "/files/a/b/c.txt", 'GET /files/*path {"path":"a/b/c.txt"}'],
    ["GET", "/files/.env", 'GET /files/*path {"path":".env"}'],
  ] as const)("%s %s -> %s", (method, path, expected) => {
    expect(matched(router, method, path)).toBe(expected);
  });

  it.each([
    ["PUT", "/json"],
    ["GET", "/nope"],
    ["GET", "/JSON"],
    ["GET", "json"],
    // Aliased spellings are 404s, not other names for a route.
    ["GET", "//json"],
    ["GET", "/json//"],
    ["GET", "/./json"],
    ["GET", "/json/."],
    ["GET", "/json/.."],
    ["GET", "/users/../json"],
    ["GET", "/users/./me"],
    ["GET", "/users/.."],
    ["GET", "/users/."],
    ["GET", "/files/../json"],
    ["GET", "/files/a/./b"],
    ["GET", "/.."],
    ["GET", "/."],
    // Routes registered with a dot segment stay unreachable under their own spelling.
    ["GET", "/a/./b"],
    ["GET", "/a/../c"],
    ["GET", "/a/b"],
    ["GET", "/c"],
  ] as const)("%s %s -> no match", (method, path) => {
    expect(matched(router, method, path)).toBeNull();
  });

  it("returns the shared empty params for a static match, as before", () => {
    const first = router.match("GET", "/json");
    const viaTrailingSlash = router.match("GET", "/json/");
    expect(first?.params).toBe(viaTrailingSlash?.params);
    expect(Object.isFrozen(first?.params)).toBe(true);
    expect(first?.rawParams).toBe(first?.params);
    expect(first?.handler).toBe(handler);
    // Each call still gets its own match object.
    expect(router.match("GET", "/json")).not.toBe(first);
  });

  it("sees a method added to a static path after its first route", () => {
    const late = new Router();
    late.addRoute("GET", "/thing", handler);
    expect(matched(late, "PATCH", "/thing")).toBeNull();
    late.addRoute("PATCH", "/thing", handler);
    expect(matched(late, "PATCH", "/thing")).toBe("PATCH /thing {}");
    expect(matched(late, "GET", "/thing")).toBe("GET /thing {}");
  });

  it("reports the same paths and methods for 404-versus-405 decisions", () => {
    expect(router.hasPath("/json")).toBe(true);
    expect(router.hasPath("/json/")).toBe(true);
    expect(router.hasPath("/users/42")).toBe(true);
    expect(router.hasPath("/nope")).toBe(false);
    expect(router.hasPath("/./json")).toBe(false);
    expect(router.hasPath("/files/anything")).toBe(false);
    expect(router.allowedMethods("/json")).toEqual(["GET", "HEAD", "POST"]);
    expect(router.allowedMethods("/users/me")).toEqual(["GET", "HEAD", "DELETE"]);
    expect(router.allowedMethods("/")).toEqual(["GET", "HEAD"]);
    expect(router.allowedMethods("/users/../json")).toEqual([]);
  });
});

describe("Router.match with ignoreTrailingSlash: false", () => {
  const strict = build({ ignoreTrailingSlash: false });

  it.each([
    ["/json", "GET /json {}"],
    ["/", "GET / {}"],
    ["/users/me", "GET /users/me {}"],
    ["/users/42", 'GET /users/:id {"id":"42"}'],
    // The route registered as "/trailing/" is stored without its slash.
    ["/trailing", "GET /trailing/ {}"],
  ] as const)("GET %s -> %s", (path, expected) => {
    expect(matched(strict, "GET", path)).toBe(expected);
  });

  it.each(["/json/", "/users/me/", "/users/42/", "/trailing/", "//json", "/./json"])("GET %s -> no match", (path) => {
    expect(matched(strict, "GET", path)).toBeNull();
  });
});
