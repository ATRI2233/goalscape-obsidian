// test/check.mjs —— 改完代码到能提交之间的那一串手工动作，收成一条命令。
//
//   npm run check              类型检查 → 打包 → 部署到 vault → 纯逻辑单测 → 实机回归
//   npm run check -- forest    实机回归只跑名字含 forest 的步骤
//   npm run check -- --no-ui   不碰界面（Obsidian 没开调试端口时也是这个行为）
//
// 只有实机回归需要真实 Obsidian：以 --remote-debugging-port=9333 启动、窗口在最前台。
// 端口不通时这一步记为 SKIP 而不是失败 —— 构建和单测照样给结论，不用为了跑测试去开应用。

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VAULT = process.env.GS_VAULT || "D:/all codes projeck/ob库--个人记录";
const DEST = join(VAULT, ".obsidian", "plugins", "goalscape-obsidian");
const CDP = process.env.GS_CDP || "http://127.0.0.1:9333";

const args = process.argv.slice(2);
const noUi = args.includes("--no-ui");
const uiArgs = args.filter((a) => !a.startsWith("--"));
const t0 = Date.now();
const failed = [];

function stage(name, cmdArgs) {
  const s = Date.now();
  console.log(`\n── ${name} ──────────────────────────────`);
  const r = spawnSync(process.execPath, cmdArgs, { cwd: ROOT, stdio: "inherit" });
  const secs = ((Date.now() - s) / 1000).toFixed(1);
  if (r.status !== 0) {
    failed.push(`${name}（${secs}s）`);
    console.log(`✖ ${name} 失败 ${secs}s`);
    return false;
  }
  console.log(`✔ ${name} ${secs}s`);
  return true;
}

async function cdpAlive() {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 1200);
    const pages = await (await fetch(`${CDP}/json/list`, { signal: ac.signal })).json();
    clearTimeout(timer);
    return pages.filter((p) => p.type === "page").length;
  } catch {
    return 0;
  }
}

// 全程用 node 直接拉本地 bin：Windows 上 spawnSync 不经 shell 是起不了 npm.cmd 的。
if (!stage("类型检查", ["node_modules/typescript/bin/tsc", "-noEmit", "-skipLibCheck"])) process.exit(1);
if (!stage("打包", ["esbuild.config.mjs", "production"])) process.exit(1);
stage("纯逻辑单测", ["test/run-tests.mjs"]);

const files = ["main.js", "styles.css", "manifest.json"];
if (!existsSync(DEST)) mkdirSync(DEST, { recursive: true });
for (const f of files) copyFileSync(join(ROOT, f), join(DEST, f));
console.log(`\n✔ 部署 ${files.join(", ")} → ${DEST}`);

if (noUi) {
  console.log("\n── 实机回归：--no-ui 已跳过");
} else if (!(await cdpAlive())) {
  console.log(`\n── 实机回归 SKIP：${CDP} 上没有页面。`);
  console.log("   需要它时：Obsidian --remote-debugging-port=9333 启动、窗口点到最前台，");
  console.log("   再跑 npm run test:ui（可只跑某几步：node test/ui-regression.mjs forest）");
} else {
  stage("实机回归", ["test/ui-regression.mjs", ...uiArgs]);
}

console.log(
  `\n总计 ${((Date.now() - t0) / 1000).toFixed(1)}s · ` +
  (failed.length ? `失败：${failed.join("，")}` : "构建与单测通过")
);
process.exit(failed.length ? 1 : 0);
