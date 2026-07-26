// create-celsian -- guards that scaffolded projects can actually START
//
// Why this file exists: every other test in this package (and every test inside
// the generated project) exercises routes through app.inject(), which never
// calls startWorker(). So a template could ship a task definition that makes
// serve() throw on boot and the whole suite would stay green. That is exactly
// what happened once: the `full` template shipped a cleanup task with
// timeout: 30_000 against a default visibility timeout of 30_000, and
// startWorker() rejects an equal-or-greater value. All 10 generated tests
// passed while `npm run dev`, the first command the README gives you, crashed.
//
// These tests assert the boot-time invariants directly against the generated
// source, so they fail on the template rather than on a user's first run.
// Relative import: create-celsian deliberately does not depend on @celsian/core,
// so read the constant from source rather than adding a dependency for a test.
import { describe, expect, it } from "vitest";
import { DEFAULT_VISIBILITY_TIMEOUT } from "../../core/src/queue.js";
import { templates } from "../src/scaffold.js";

const TEMPLATE_NAMES = Object.keys(templates);

describe("scaffolded templates satisfy boot-time invariants", () => {
  it("exposes every template", () => {
    expect(TEMPLATE_NAMES.length).toBeGreaterThan(0);
  });

  describe.each(TEMPLATE_NAMES)("%s", (name) => {
    const files = templates[name] as Record<string, string>;

    it("keeps every task timeout below the queue visibility timeout", () => {
      // startWorker() throws when a task timeout is >= the visibility timeout,
      // because a task outliving its lease is redelivered and runs alongside
      // itself. A scaffold must never ship a value that trips that guard.
      for (const [path, contents] of Object.entries(files)) {
        for (const match of contents.matchAll(/timeout:\s*([\d_]+)/g)) {
          const value = Number(match[1].replaceAll("_", ""));
          expect(
            value,
            `${name}/${path} declares timeout ${value}ms, which is not below the ` +
              `default visibility timeout of ${DEFAULT_VISIBILITY_TIMEOUT}ms, so startWorker() would throw at boot`,
          ).toBeLessThan(DEFAULT_VISIBILITY_TIMEOUT);
        }
      }
    });

    it("never writes a body on a no-content status", () => {
      // The Response constructor rejects a body on 204/304, so
      // reply.status(204).json(...) is a guaranteed 500 at request time.
      for (const [path, contents] of Object.entries(files)) {
        expect(
          contents,
          `${name}/${path} calls .json() on a 204/304 response, which throws at runtime. Use .send(null).`,
        ).not.toMatch(/status\(\s*(?:204|304)\s*\)\s*\.json\(/);
      }
    });
  });
});
