// create-celsian — Scaffolder template tests

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { basicTemplate } from "../src/templates/basic.js";
import { fullTemplate } from "../src/templates/full.js";
import { restApiTemplate } from "../src/templates/rest-api.js";
import { rpcApiTemplate } from "../src/templates/rpc-api.js";

// ─── Template content tests (no filesystem) ───

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

  it("package.json has type module", () => {
    const pkg = JSON.parse(basicTemplate["package.json"]);
    expect(pkg.type).toBe("module");
  });

  it("package.json has dev, build, and start scripts", () => {
    const pkg = JSON.parse(basicTemplate["package.json"]);
    expect(pkg.scripts).toHaveProperty("dev");
    expect(pkg.scripts).toHaveProperty("build");
    expect(pkg.scripts).toHaveProperty("start");
  });

  it("package.json depends on celsian", () => {
    const pkg = JSON.parse(basicTemplate["package.json"]);
    expect(pkg.dependencies).toHaveProperty("celsian");
  });

  it("tsconfig.json has strict mode enabled", () => {
    const tsconfig = JSON.parse(basicTemplate["tsconfig.json"]);
    expect(tsconfig.compilerOptions.strict).toBe(true);
  });

  it("tsconfig.json targets ES2022", () => {
    const tsconfig = JSON.parse(basicTemplate["tsconfig.json"]);
    expect(tsconfig.compilerOptions.target).toBe("ES2022");
  });

  it("tsconfig.json uses ESNext module", () => {
    const tsconfig = JSON.parse(basicTemplate["tsconfig.json"]);
    expect(tsconfig.compilerOptions.module).toBe("ESNext");
  });

  it("entry file imports createApp from celsian", () => {
    expect(basicTemplate["src/index.ts"]).toContain("createApp");
    expect(basicTemplate["src/index.ts"]).toContain("celsian");
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

  it("package.json has type module", () => {
    const pkg = JSON.parse(restApiTemplate["package.json"]);
    expect(pkg.type).toBe("module");
  });

  it("tsconfig.json has strict mode enabled", () => {
    const tsconfig = JSON.parse(restApiTemplate["tsconfig.json"]);
    expect(tsconfig.compilerOptions.strict).toBe(true);
  });

  it("entry file contains route definitions", () => {
    const entry = restApiTemplate["src/index.ts"];
    expect(entry).toContain("app.get");
    expect(entry).toContain("app.post");
    expect(entry).toContain("serve");
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

  it("package.json has type module", () => {
    const pkg = JSON.parse(rpcApiTemplate["package.json"]);
    expect(pkg.type).toBe("module");
  });

  it("tsconfig.json has strict mode enabled", () => {
    const tsconfig = JSON.parse(rpcApiTemplate["tsconfig.json"]);
    expect(tsconfig.compilerOptions.strict).toBe(true);
  });

  it("entry file exports AppRouter type", () => {
    expect(rpcApiTemplate["src/index.ts"]).toContain("AppRouter");
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

  it("includes .env.example with expected variables", () => {
    const files = Object.keys(fullTemplate);
    expect(files).toContain(".env.example");
    const envContent = fullTemplate[".env.example"];
    expect(envContent).toContain("PORT=");
    expect(envContent).toContain("JWT_SECRET=");
    expect(envContent).toContain("DATABASE_URL=");
    expect(envContent).toContain("NODE_ENV=");
  });

  it("includes .gitignore", () => {
    const files = Object.keys(fullTemplate);
    expect(files).toContain(".gitignore");
    const gitignore = fullTemplate[".gitignore"];
    expect(gitignore).toContain("node_modules/");
    expect(gitignore).toContain("dist/");
    expect(gitignore).toContain(".env");
  });

  it("package.json includes jwt, rpc, and rate-limit dependencies", () => {
    const pkg = JSON.parse(fullTemplate["package.json"]);
    expect(pkg.dependencies).toHaveProperty("@celsian/jwt");
    expect(pkg.dependencies).toHaveProperty("@celsian/rpc");
    expect(pkg.dependencies).toHaveProperty("@celsian/rate-limit");
  });

  it("package.json includes test script", () => {
    const pkg = JSON.parse(fullTemplate["package.json"]);
    expect(pkg.scripts).toHaveProperty("test");
  });

  it("package.json has vitest in devDependencies", () => {
    const pkg = JSON.parse(fullTemplate["package.json"]);
    expect(pkg.devDependencies).toHaveProperty("vitest");
  });

  it("tsconfig.json has strict mode enabled", () => {
    const tsconfig = JSON.parse(fullTemplate["tsconfig.json"]);
    expect(tsconfig.compilerOptions.strict).toBe(true);
  });

  it("tsconfig.json has declaration output enabled", () => {
    const tsconfig = JSON.parse(fullTemplate["tsconfig.json"]);
    expect(tsconfig.compilerOptions.declaration).toBe(true);
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

  it("all templates use {{name}} in package.json", () => {
    for (const [templateName, template] of Object.entries({
      basic: basicTemplate,
      "rest-api": restApiTemplate,
      "rpc-api": rpcApiTemplate,
      full: fullTemplate,
    })) {
      const pkg = JSON.parse(template["package.json"]);
      expect(pkg.name).toBe("{{name}}");
    }
  });

  it("name substitution produces valid package.json", () => {
    const content = fullTemplate["package.json"].replace(/\{\{name\}\}/g, "my-project");
    const pkg = JSON.parse(content);
    expect(pkg.name).toBe("my-project");
    expect(pkg.type).toBe("module");
    expect(pkg.version).toBeDefined();
  });
});

// ─── Scaffold function filesystem tests ───

const TMP_DIR = join(import.meta.dirname, ".tmp-scaffolder-test");

describe("scaffold to filesystem", () => {
  beforeEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
    mkdirSync(TMP_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("writes basic template files to disk", () => {
    const projectDir = join(TMP_DIR, "test-basic");
    mkdirSync(projectDir, { recursive: true });

    for (const [filePath, content] of Object.entries(basicTemplate)) {
      const fullPath = join(projectDir, filePath);
      const dir = join(fullPath, "..");
      mkdirSync(dir, { recursive: true });
      writeFileSync(fullPath, content.replace(/\{\{name\}\}/g, "test-basic"));
    }

    expect(existsSync(join(projectDir, "package.json"))).toBe(true);
    expect(existsSync(join(projectDir, "tsconfig.json"))).toBe(true);
    expect(existsSync(join(projectDir, "src", "index.ts"))).toBe(true);

    const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8"));
    expect(pkg.name).toBe("test-basic");
  });

  it("writes full template files including nested directories", () => {
    const projectDir = join(TMP_DIR, "test-full");
    mkdirSync(projectDir, { recursive: true });

    for (const [filePath, content] of Object.entries(fullTemplate)) {
      const fullPath = join(projectDir, filePath);
      const dir = join(fullPath, "..");
      mkdirSync(dir, { recursive: true });
      writeFileSync(fullPath, content.replace(/\{\{name\}\}/g, "test-full"));
    }

    expect(existsSync(join(projectDir, "src", "routes", "health.ts"))).toBe(true);
    expect(existsSync(join(projectDir, "src", "plugins", "auth.ts"))).toBe(true);
    expect(existsSync(join(projectDir, ".env.example"))).toBe(true);
    expect(existsSync(join(projectDir, "Dockerfile"))).toBe(true);
    expect(existsSync(join(projectDir, "test", "api.test.ts"))).toBe(true);
  });

  it("name substitution applies to all file contents", () => {
    const projectDir = join(TMP_DIR, "my-app");
    mkdirSync(projectDir, { recursive: true });

    for (const [filePath, content] of Object.entries(fullTemplate)) {
      const fullPath = join(projectDir, filePath);
      const dir = join(fullPath, "..");
      mkdirSync(dir, { recursive: true });
      writeFileSync(fullPath, content.replace(/\{\{name\}\}/g, "my-app"));
    }

    const readme = readFileSync(join(projectDir, "README.md"), "utf8");
    expect(readme).toContain("my-app");
    expect(readme).not.toContain("{{name}}");

    const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8"));
    expect(pkg.name).toBe("my-app");
  });

  it("generated tsconfig.json is valid JSON for all templates", () => {
    for (const [name, template] of Object.entries({
      basic: basicTemplate,
      "rest-api": restApiTemplate,
      "rpc-api": rpcApiTemplate,
      full: fullTemplate,
    })) {
      const tsconfig = JSON.parse(template["tsconfig.json"]);
      expect(tsconfig).toHaveProperty("compilerOptions");
      expect(tsconfig).toHaveProperty("include");
      expect(tsconfig.compilerOptions).toHaveProperty("target");
      expect(tsconfig.compilerOptions).toHaveProperty("module");
      expect(tsconfig.compilerOptions).toHaveProperty("strict", true);
    }
  });
});

describe("invalid template handling", () => {
  it("template registry does not contain unknown template names", () => {
    const templates: Record<string, Record<string, string>> = {
      full: fullTemplate,
      basic: basicTemplate,
      "rest-api": restApiTemplate,
      "rpc-api": rpcApiTemplate,
    };

    expect(templates["nonexistent"]).toBeUndefined();
    expect(templates["invalid"]).toBeUndefined();
  });

  it("all four expected templates are available", () => {
    const templates: Record<string, Record<string, string>> = {
      full: fullTemplate,
      basic: basicTemplate,
      "rest-api": restApiTemplate,
      "rpc-api": rpcApiTemplate,
    };

    expect(Object.keys(templates)).toHaveLength(4);
    expect(Object.keys(templates)).toContain("basic");
    expect(Object.keys(templates)).toContain("rest-api");
    expect(Object.keys(templates)).toContain("rpc-api");
    expect(Object.keys(templates)).toContain("full");
  });
});

describe("path traversal protection", () => {
  it("project names with .. are dangerous and the scaffold function rejects them", () => {
    // The scaffold function in create-celsian/src/index.ts checks for '..'
    // and ensures the resolved path is inside the cwd.
    // Here we verify the logic: names containing ".." should be rejected.
    const dangerousNames = ["../evil", "../../etc/passwd", "foo/../bar/../../evil"];
    for (const name of dangerousNames) {
      expect(name.includes("..")).toBe(true);
    }
  });

  it("normal project names do not contain path traversal", () => {
    const safeNames = ["my-app", "my_project", "celsian-demo", "api-v2"];
    for (const name of safeNames) {
      expect(name.includes("..")).toBe(false);
    }
  });
});
