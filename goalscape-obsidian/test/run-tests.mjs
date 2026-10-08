// 数据层单测入口：用仓库里已有的 esbuild 把 src/data/__tests__/*.test.ts 打包成
// Node 能直接跑的 ESM，再交给内置的 node:test 执行。不引入第三方测试框架。
//
//   npm test            全部
//   npm test crud       只跑文件名含 crud 的
//
// 产物落在 node_modules/.goalscape-tests/（已被 .gitignore 覆盖），带 inline sourcemap，
// 失败栈能直接指回 .ts 源码行。

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const testDir = join(root, "src", "data", "__tests__");
const outDir = join(root, "node_modules", ".goalscape-tests");

const all = readdirSync(testDir)
  .filter((f) => f.endsWith(".test.ts"))
  .sort();
const filter = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const files = filter.length ? all.filter((f) => filter.some((k) => f.includes(k))) : all;

if (!files.length) {
  console.error(
    `没有匹配的测试文件（${testDir} 下有 ${all.length} 个：${all.join(", ")}）`
  );
  process.exit(1);
}

await build({
  entryPoints: files.map((f) => join(testDir, f)),
  outdir: outDir,
  outExtension: { ".js": ".mjs" },
  absWorkingDir: root,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: "inline",
  logLevel: "warning",
  // obsidian 只有类型没有运行时实现，换成 test/mocks/obsidian.ts
  alias: { obsidian: join(root, "test", "mocks", "obsidian.ts") },
});

const outs = files.map((f) => join(outDir, f.replace(/\.ts$/, ".mjs")));
const result = spawnSync(
  process.execPath,
  ["--test", "--test-reporter=spec", ...outs],
  { stdio: "inherit", cwd: root }
);
process.exit(result.status ?? 1);
