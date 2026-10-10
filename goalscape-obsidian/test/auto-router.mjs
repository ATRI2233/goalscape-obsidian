// test/auto-router.mjs —— 把"改了哪些文件"翻成"实机回归该跑哪几步"。
//
// 全量 16 步里 28s 花在等界面稳定上，改一行也等 28 次没有意义。这里的判据只有一条：
// 漏一步的代价是提交时全量兜底才发现，所以任何一点不确定都倒向全量（返回 null）。
// 这张表可以慢慢调准，但它不能给出"绿了其实没测"的假信号。
//
// 两个信息源，按性价比排序：
//   路径   —— 多数模块只服务一个画面（palette 只影响配色、canvasSync 只影响白板）。
//   diff 正文 —— radialView.ts / main.ts 每个功能都会碰，路径给不出结论，只能看动了哪些标识符。

import { spawnSync } from "node:child_process";

/** 步骤关键词按 ui-regression 的 step 名做子串匹配：步骤文案会润色，别改成精确名 */
const G = {
  forest: ["forest", "viewport"],
  viewport: ["viewport"],
  color: ["color", "settings", "themes"],
  notes: ["notes"],
  canvas: ["canvas", "mirror", "settings"],
  filter: ["filter"],
  shell: ["toolbar", "view-switch", "map-menu", "file-menu"],
};

/** 命中这些符号说明改的是生命周期/组合根本身，影响面覆盖所有画面，不猜 */
const WIDE = /\b(onload|onunload|onLayoutReady|addCommand|addRibbon|openView|activateView|setState|onOpen|onClose)\b/;

const PATH_ROUTES = [
  [/^src\/geometry\//, ["forest"]],
  [/^src\/data\/palette\.ts$/, ["color"]],
  [/^src\/data\/(notes|noteFiles)\.ts$/, ["notes"]],
  [/^src\/data\/(types|crud|goalTree|rollup)\.ts$/, ["forest", "filter", "notes"]],
  [/^src\/data\/templates\.ts$/, ["forest", "shell"]],
  [/^src\/views\/radialDrag\.ts$/, ["viewport"]],
  [/^src\/views\/focusFilter\.ts$/, ["filter"]],
  [/^src\/views\/(listView|ganttView|viewSwitcher)\.ts$/, ["shell"]],
  [/^src\/views\/(infoPanel|promptModal|radialMenu)\.ts$/, ["notes"]],
  [/^src\/export\/canvas/, ["canvas", "notes"]],
  [/^src\/settingsTab\.ts$/, ["color", "canvas"]],
  // 导出层：CSV/大纲/SVG 没有对应实机步骤，单测已经把字符串逐行断言了
  [/^src\/export\/(exporters|svgExport|download)\.ts$/, []],
  [/^styles\.css$/, ["color", "forest", "notes"]],
];

/** 顺序无关：命中的全部并起来；一个都不命中就退回全量 */
const SYMBOL_ROUTES = {
  "src/main.ts": [
    [/canvas|mirror|白板/i, ["canvas"]],
    [/note|ownerOf|reveal/i, ["notes"]],
    [/settings|tone|Theme|autoUpdate/i, ["color", "canvas"]],
    [/Goalscape|scapeName|switchS|createS|deleteS|renameS/, ["shell"]],
    [/listView|ganttView|radialView|ViewType/, ["shell"]],
  ],
  "src/views/radialView.ts": [
    [/wheel|zoom|pan|viewBoxOf|pointer(move|up|down)|translate/i, ["forest"]],
    [/arcPath|sector|fitLabel|bandScale|drawNode|bevel|rim|gradSeq|unit/, ["forest"]],
    [/Fill|fill|labelInk|palette|tone|hue|color/i, ["color"]],
    [/NoteCard|notes\.get|chip|revealGoal|firstLine|refs/, ["notes"]],
    [/filterCriteria|matching|dimmed/, ["filter"]],
    [/mapButton|scapeName|showMapMenu/, ["shell"]],
    [/toolbar|switcher|viewType/, ["shell"]],
    [/reparent|weightDrag|collapsed/, ["forest"]],
  ],
};

/** 只影响单测、不需要真实界面就能验的改动 */
const TEST_ONLY = /^(src\/[^/]+\/__tests__\/|test\/(run-tests|check|auto-router)\.mjs|test\/(helpers|mocks)\/)/;
/** 构建产物、清单与文档：实机跑的是部署好的 main.js，它自己改了不说明任何东西 */
const IRRELEVANT = /(^|\/)(main\.js|manifest\.json|package(-lock)?\.json|version\.json|\.gitignore)$|\.md$/;
const SOURCE = /^(src\/.*\.ts|styles\.css)$/;

export const RELOAD = "reload";

/**
 * @param changed  [{path, diff, added}] path 相对插件目录，diff 是该文件的 -U0 正文
 * @returns {{steps: string[]|null, why: string}} steps=null 跑全量；steps=[] 实机这步可以整段跳过
 */
export function routeSteps(changed) {
  // 工作区干净：没有未提交的改动可测（提交前的全量 check 是另一道门禁，不靠这里）
  if (!changed.length) return { steps: [], why: "工作区没有改动" };

  const hits = new Set();
  // 全量理由收集起来一起说：一次改动往往同时踩中好几条，只报第一条会让人以为其余的都路由上了
  const blockers = [];
  let anyLive = false;

  for (const { path, diff, added } of changed) {
    if (IRRELEVANT.test(path)) continue;
    if (TEST_ONLY.test(path)) continue;
    // 断言脚本自己变了：改的是"测什么"，必须整套重跑一次才知道有没有把别的步骤碰坏
    if (path === "test/ui-regression.mjs") blockers.push("实机回归脚本本身改了");
    else if (!SOURCE.test(path)) blockers.push(`路由表不认识 ${path}`);
    else if (added) blockers.push(`新增源文件 ${path}，没有历史可推断`);
    else if (SYMBOL_ROUTES[path]) {
      const symbols = SYMBOL_ROUTES[path];
      if (WIDE.test(diff)) blockers.push(`${path} 改到了生命周期/注册`);
      else {
        const matched = symbols.filter(([re]) => re.test(diff));
        if (!matched.length) blockers.push(`${path} 的改动没命中任何符号`);
        else {
          for (const [, groups] of matched) for (const k of groups.flatMap((g) => G[g])) hits.add(k);
          anyLive = true;
        }
      }
    } else {
      const route = PATH_ROUTES.find(([re]) => re.test(path));
      if (!route) blockers.push(`路由表里没有 ${path}`);
      else {
        for (const k of route[1].flatMap((g) => G[g])) hits.add(k);
        if (route[1].length) anyLive = true;
      }
    }
  }

  if (blockers.length) return { steps: null, why: blockers.join("；") };
  if (!anyLive) return { steps: [], why: "改动只涉及测试/文档/导出，实机步骤用不上" };
  const steps = [...new Set([RELOAD, ...Object.keys(G).flatMap((g) => G[g]).filter((k) => hits.has(k))])];
  return { steps, why: `${changed.length} 个改动文件 → ${steps.length} 个步骤关键词` };
}

/** 在插件目录下跑 git，拿到"每个改动文件的 diff 正文"。路径统一剥掉仓库根前缀。 */
export function readChanged(cwd) {
  // 三个 git 调用都带 `-- .`：仓库根还有 README/PROGRESS 这些文档，混进来会被当成"不认识的路径"，
  // 于是每次文档改动都退化成全量。
  const git = (a, scoped = true) =>
    spawnSync("git", scoped ? [...a, "--", "."] : a, { cwd, encoding: "utf8" });
  const base = git(["diff", "-U0", "HEAD"]);
  if (base.status !== 0) return { error: (base.stderr || base.stdout || "git diff 失败").trim() };

  const prefix = git(["rev-parse", "--show-prefix"], false);
  const strip = prefix.status === 0 ? prefix.stdout.trim() : "";
  const rel = (p) => (strip && p.startsWith(strip) ? p.slice(strip.length) : p);

  const byFile = new Map();
  let cur = null;
  for (const line of base.stdout.split("\n")) {
    const m = /^diff --git a\/.+ b\/(.+)$/.exec(line);
    if (m) {
      cur = rel(m[1]);
      byFile.set(cur, { path: cur, diff: "", added: false });
      continue;
    }
    // 正文里以 + 开头的行才是"新写的内容"；hunk 头与上下文不参与符号探测
    if (cur && line.startsWith("+") && !line.startsWith("+++")) byFile.get(cur).diff += line + "\n";
  }

  const others = git(["diff", "--name-status", "HEAD"]);
  if (others.status === 0) {
    for (const line of others.stdout.split("\n")) {
      const m = /^A\t(.+)$/.exec(line);
      if (m && byFile.has(rel(m[1]))) byFile.get(rel(m[1])).added = true;
    }
  }

  const untracked = git(["ls-files", "--others", "--exclude-standard"]);
  if (untracked.status === 0) {
    for (const p of untracked.stdout.split("\n").filter(Boolean)) {
      if (!byFile.has(rel(p))) byFile.set(rel(p), { path: rel(p), diff: "", added: true });
    }
  }

  return { changed: [...byFile.values()] };
}
