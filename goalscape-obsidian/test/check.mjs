// test/check.mjs —— 改完代码到能提交之间的那一串手工动作，收成一条命令。
//
//   npm run check              类型检查 → 打包 → 部署到 vault → 纯逻辑单测 → 实机回归
//   npm run check -- forest    实机回归只跑名字含 forest 的步骤
//   npm run check -- --auto    按 git diff 挑该跑的实机步骤（详见 test/auto-router.mjs）
//   npm run check -- --no-ui   不碰界面（Obsidian 没开调试端口时也是这个行为）
//
// 只有实机回归需要真实 Obsidian：以 --remote-debugging-port=9333 启动、窗口在最前台。
// 端口不通时这一步记为 SKIP 而不是失败 —— 构建和单测照样给结论，不用为了跑测试去开应用。
// vault 路径由 GS_VAULT 给（不写死进仓库）；没设时部署记 SKIP，但实机回归跑不了，它要在 vault 里建临时图。
//
// --auto 是开发循环用的：路由表可能漏，收尾/提交前照样得跑一次不带参数的 check。

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readChanged, routeSteps } from "./auto-router.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// vault 路径不写死在仓库里：GS_VAULT 没设就跳过部署那一步，构建与单测照样给结论（同 CDP 不通记 SKIP 的处理）
const VAULT = process.env.GS_VAULT;
const DEST = VAULT && join(VAULT, ".obsidian", "plugins", "goalscape-obsidian");
const CDP = process.env.GS_CDP || "http://127.0.0.1:9333";

const args = process.argv.slice(2);
const noUi = args.includes("--no-ui");
const auto = args.includes("--auto");
let uiArgs = args.filter((a) => !a.startsWith("--"));
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

// --auto 的计划先打出来，好让人在等构建时就看见"这次只测这几步"
let skipLive = false;
if (auto && !noUi) {
  if (uiArgs.length) {
    console.log(`\n── 实机回归：已显式指定步骤（${uiArgs.join(" ")}），--auto 不介入`);
  } else {
    const { changed, error } = readChanged(ROOT);
    const r = error ? { steps: null, why: error } : routeSteps(changed);
    if (r.steps === null) {
      console.log(`\n── 实机回归：全量（${r.why}）`);
    } else if (!r.steps.length) {
      skipLive = true;
      console.log(`\n── 实机回归：跳过（${r.why}）`);
    } else {
      uiArgs = r.steps;
      console.log(`\n── 实机回归：${r.why} → ${uiArgs.join(" ")}`);
    }
  }
}

// 全程用 node 直接拉本地 bin：Windows 上 spawnSync 不经 shell 是起不了 npm.cmd 的。
if (!stage("类型检查", ["node_modules/typescript/bin/tsc", "-noEmit", "-skipLibCheck"])) process.exit(1);
if (!stage("打包", ["esbuild.config.mjs", "production"])) process.exit(1);
stage("纯逻辑单测", ["test/run-tests.mjs"]);

const files = ["main.js", "styles.css", "manifest.json"];
if (!DEST) {
  console.log(
    '\n── 部署 SKIP：没设 GS_VAULT。要部署就指一次：setx GS_VAULT "D:/path/to/your-vault"（重开终端生效）'
  );
} else {
  if (!existsSync(DEST)) mkdirSync(DEST, { recursive: true });
  for (const f of files) copyFileSync(join(ROOT, f), join(DEST, f));
  console.log(`\n✔ 部署 ${files.join(", ")} → ${DEST}`);
}

if (noUi || skipLive) {
  console.log(`\n── 实机回归：${noUi ? "--no-ui 已跳过" : "本次改动没有对应的实机步骤"}`);
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
