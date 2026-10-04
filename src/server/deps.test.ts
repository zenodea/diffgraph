import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { dependencies, goSpecs, jsSpecs, pythonSpecs } from "./deps.ts";

describe("import parsing", () => {
  it("finds JS/TS imports of every kind", () => {
    const src = `import a from "./a";\nimport { b } from '../b.js'\nexport * from "./c";\nimport "./side.css";\nconst d = await import("./d");\nconst e = require("./e");\nimport type { T } from "./t";`;
    expect(jsSpecs(src).sort()).toEqual(["../b.js", "./a", "./c", "./d", "./e", "./side.css", "./t"]);
  });

  it("finds Python and Go imports", () => {
    expect(pythonSpecs("from .models import User, Group\nimport os, pkg.util\nfrom .. import config")).toEqual([
      "py:1:models", "py:1:models.User", "py:1:models.Group", "py:2:", "py:2:config", "py:0:os", "py:0:pkg.util",
    ]);
    expect(goSpecs('import "fmt"\nimport (\n  "example.com/app/db"\n  x "example.com/app/http"\n)')).toEqual(["go:fmt", "go:example.com/app/db", "go:example.com/app/http"]);
  });
});

describe("dependencies", () => {
  const dir = mkdtempSync(join(tmpdir(), "graphdiff-deps-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const write = (p: string, text: string) => {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  };

  it("links changed files and finds unchanged importers", async () => {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    write("tsconfig.json", '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }');
    write("src/server/api.ts", "export type Api = {};");
    write("src/web/client.ts", 'import type { Api } from "../server/api.js";');
    write("src/web/page.tsx", 'import { client } from "@/web/client";');
    write("src/web/other.ts", "export const x = 1;");
    write("app/models.py", "class User: ...");
    write("app/views.py", "from .models import User");
    const deps = await dependencies(dir, ["src/server/api.ts", "src/web/client.ts", "app/models.py"]);
    expect(deps.edges).toContainEqual({ from: "src/web/client.ts", to: "src/server/api.ts" });
    expect(deps.edges).toContainEqual({ from: "src/web/page.tsx", to: "src/web/client.ts" });
    expect(deps.edges).toContainEqual({ from: "app/views.py", to: "app/models.py" });
    expect(deps.dependents).toEqual(["app/views.py", "src/web/page.tsx"]);
  });
});
