// create-celsian — Scaffolder template tests

import { describe, expect, it } from "vitest";
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

describe("template name substitution", () => {
  it("basic template entry references createApp", () => {
    expect(basicTemplate["src/index.ts"]).toContain("createApp");
    expect(basicTemplate["src/index.ts"]).toContain("serve");
  });

  it("full template README uses the name placeholder", () => {
    expect(fullTemplate["README.md"]).toContain("{{name}}");
  });
});
