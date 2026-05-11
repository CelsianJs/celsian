// create-celsian — Scaffolder template tests

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scaffold } from "../src/index.js";
import { basicTemplate } from "../src/templates/basic.js";
import { fullTemplate } from "../src/templates/full.js";
import { restApiTemplate } from "../src/templates/rest-api.js";
import { rpcApiTemplate } from "../src/templates/rpc-api.js";

describe("basic template", () => {
  it("contains the expected files", () => {
    const files = Object.keys(basicTemplate);
    expect(files).toContain("package.json");
    expect(files).toContain("tsconfig.json");
    expect(files).toContain("src/index.ts");
  });

  it("package.json contains the project name placeholder", () => {
    const pkg = JSON.parse(basicTemplate["package.json"]);
    expect(pkg.name).toBe("{{name}}");
  });
});

describe("rest-api template", () => {
  it("contains the expected files", () => {
    const files = Object.keys(restApiTemplate);
    expect(files).toContain("package.json");
    expect(files).toContain("tsconfig.json");
    expect(files).toContain("src/index.ts");
  });

  it("package.json includes typebox dependency", () => {
    const pkg = JSON.parse(restApiTemplate["package.json"]);
    expect(pkg.dependencies).toHaveProperty("@sinclair/typebox");
  });

  it("entry file imports TypeBox", () => {
    expect(restApiTemplate["src/index.ts"]).toContain("@sinclair/typebox");
  });
});

describe("rpc-api template", () => {
  it("contains the expected files", () => {
    const files = Object.keys(rpcApiTemplate);
    expect(files).toContain("package.json");
    expect(files).toContain("tsconfig.json");
    expect(files).toContain("src/index.ts");
  });

  it("package.json includes rpc dependency", () => {
    const pkg = JSON.parse(rpcApiTemplate["package.json"]);
    expect(pkg.dependencies).toHaveProperty("@celsian/rpc");
  });

  it("entry file imports RPC modules", () => {
    expect(rpcApiTemplate["src/index.ts"]).toContain("@celsian/rpc");
    expect(rpcApiTemplate["src/index.ts"]).toContain("RPCHandler");
  });
});

describe("full template", () => {
  it("contains all required files", () => {
    const files = Object.keys(fullTemplate);
    expect(files).toContain("package.json");
    expect(files).toContain("tsconfig.json");
    expect(files).toContain("src/index.ts");
    expect(files).toContain("src/types.ts");
    expect(files).toContain("src/routes/health.ts");
    expect(files).toContain("src/routes/users.ts");
    expect(files).toContain("src/routes/rpc.ts");
    expect(files).toContain("src/plugins/auth.ts");
    expect(files).toContain("src/plugins/database.ts");
    expect(files).toContain("src/plugins/security.ts");
  });

  it("package.json contains the project name placeholder", () => {
    const pkg = JSON.parse(fullTemplate["package.json"]);
    expect(pkg.name).toBe("{{name}}");
  });

  it("includes Dockerfile and README", () => {
    const files = Object.keys(fullTemplate);
    expect(files).toContain("Dockerfile");
    expect(files).toContain("README.md");
  });

  it("includes test scaffold", () => {
    const files = Object.keys(fullTemplate);
    expect(files).toContain("test/api.test.ts");
  });
});

describe("template dependency ranges", () => {
  it("basic template tracks the current celsian release line", () => {
    const pkg = JSON.parse(basicTemplate["package.json"]);
    expect(pkg.dependencies.celsian).toBe("^0.3.12");
  });

  it("rest-api template tracks the current celsian release line", () => {
    const pkg = JSON.parse(restApiTemplate["package.json"]);
    expect(pkg.dependencies.celsian).toBe("^0.3.12");
  });

  it("rpc-api template tracks the current celsian and rpc release lines", () => {
    const pkg = JSON.parse(rpcApiTemplate["package.json"]);
    expect(pkg.dependencies.celsian).toBe("^0.3.12");
    expect(pkg.dependencies["@celsian/rpc"]).toBe("^0.3.11");
  });

  it("full template tracks the current public package release lines", () => {
    const pkg = JSON.parse(fullTemplate["package.json"]);
    expect(pkg.dependencies.celsian).toBe("^0.3.12");
    expect(pkg.dependencies["@celsian/core"]).toBe("^0.3.11");
    expect(pkg.dependencies["@celsian/jwt"]).toBe("^0.3.11");
    expect(pkg.dependencies["@celsian/rpc"]).toBe("^0.3.11");
    expect(pkg.dependencies["@celsian/rate-limit"]).toBe("^0.3.11");
  });
});

describe("template name substitution", () => {
  it("basic template entry references createApp", () => {
    expect(basicTemplate["src/index.ts"]).toContain("createApp");
    expect(basicTemplate["src/index.ts"]).toContain("serve");
  });

  it("full template README uses the name placeholder", () => {
    expect(fullTemplate["README.md"]).toContain("{{name}}");
  });
});

const TMP_DIR = join(import.meta.dirname, ".tmp-scaffolder-test");

describe("create-celsian scaffold safety", () => {
  beforeEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
    mkdirSync(TMP_DIR, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("refuses to overwrite an existing non-empty target directory", () => {
    const originalCwd = process.cwd();
    const target = join(TMP_DIR, "existing-app");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "package.json"), '{"name":"keep-me"}\n');
    process.chdir(TMP_DIR);
    try {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
        throw new Error(`exit:${code}`);
      }) as never);

      expect(() => scaffold("existing-app", "basic", "npm")).toThrow("exit:1");
      expect(readFileSync(join(target, "package.json"), "utf8")).toBe('{"name":"keep-me"}\n');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("rejects traversal outside the working directory", () => {
    const originalCwd = process.cwd();
    process.chdir(TMP_DIR);
    try {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
        throw new Error(`exit:${code}`);
      }) as never);

      expect(() => scaffold("../escape", "basic", "npm")).toThrow("exit:1");
      expect(existsSync(join(TMP_DIR, "..", "escape"))).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("sanitizes the generated package name without changing the target directory", () => {
    const originalCwd = process.cwd();
    process.chdir(TMP_DIR);
    try {
      scaffold("My App!", "basic", "npm");
      const pkg = JSON.parse(readFileSync(join(TMP_DIR, "My App!", "package.json"), "utf8"));
      expect(pkg.name).toBe("my-app");
    } finally {
      process.chdir(originalCwd);
    }
  });
});
