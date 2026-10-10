// test/ui-regression.mjs
// 真实 Obsidian 界面回归：把散在 D:/tmp 的 tb_a/tb_b/tb_c 收敛成一份常驻脚本。
//
//   npm run test:ui                          全部
//   node test/ui-regression.mjs toolbar map  只跑名字含这些词的步骤
//   npm run check                            一条命令跑完：检查/打包/部署/单测 + 这一步
//                                            （9333 不通时这一步记 SKIP，不当失败）
//
// 前提：Obsidian 以 --remote-debugging-port=9333 启动，**窗口必须在最前台**
// （后台 renderer 会被挂起，任何 CDP 命令都不响应），且 vault 里已装好本插件的
// main.js / styles.css。脚本会 disable→enable 插件一次（换 main.js 后不重载仍是旧代码），
// 所以别在手编辑正忙时跑。
//
// 数据卫生：唯一写进 vault 的是 ZZ_GS_UI_REGRESSION 临时图（含它的 .canvas），
// 结束时无论成败都删掉，并把 store.path / data.json / 活动标签 / 主题还原成开始时的值。
// 用户自己的图只读；跑动期间若 mtime 变了只报 INFO 不回滚（多半是用户本人在改）。
//
// 断言按**结构**写、不按界面文案写（类名、svg 子元素个数、input type 计数）：
// 上一版 4 个"FAIL"全是脚本期望错（打勾类名是 mod-checked、lucide 图标是 circle/line/rect
// 而非 path），界面微调也会连带改坏断言。
//
// 等待按"能不能验"分三等：能验就轮询谓词（waitFor / 页内等 pl.toneSettings 收到目标值、
// 等 data.json 真写进去）→ 只能等浏览器排版完就 __gsSettle(两帧，上限兜底) →
// 固定 setTimeout 只剩 6 处，等的都是 Obsidian 自己的异步
// （插件重载、换视图、开原生菜单、建文件），不是"我们渲染完了没"。
// 轮询比等帧准：窗口不在前台时 rAF 会整个停下来，两帧可能几分钟不来。
// 能在 npm test（2 秒、不开界面）里判的东西一律不放这儿。

import fs from "node:fs";
import path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CDP = process.env.GS_CDP || "http://127.0.0.1:9333";
// 这一步非要有 vault 不可：临时图 ZZ_* 就建在它的 Goalscapes/ 下，路径不写死在仓库里
const VAULT = process.env.GS_VAULT;
if (!VAULT) {
  console.error(
    '缺少 GS_VAULT：指向那个已装本插件的 Obsidian vault。一次性设置：setx GS_VAULT "D:/path/to/your-vault"（重开终端生效）'
  );
  process.exit(1);
}
const PLUGIN = "goalscape-obsidian";
const SCAPE_DIR_NAME = "Goalscapes";
const SCAPE_DIR = path.join(VAULT, SCAPE_DIR_NAME);
const SHOT_DIR = path.join(ROOT, "node_modules", ".goalscape-ui");
const TMP_NAME = "ZZ_GS_UI_REGRESSION";
const TMP_PATH = `${SCAPE_DIR_NAME}/${TMP_NAME}.goalscape.json`;
const TMP_CANVAS = `${SCAPE_DIR_NAME}/${TMP_NAME}.canvas`;
/** 临时图的笔记目录：NoteStore 按 <图名>.notes/ 建，跑完必须一并删掉 */
const NOTES_DIR = `${SCAPE_DIR_NAME}/${TMP_NAME}.notes`;
const RADIAL = "goalscape-radial-view";
const VIEW_TYPES = [RADIAL, "goalscape-list-view", "goalscape-gantt-view"];
const PL = `app.plugins.plugins[${JSON.stringify(PLUGIN)}]`;

const argFilter = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const wanted = (name) => !argFilter.length || argFilter.some((k) => name.includes(k));

let pass = 0, fail = 0, skip = 0;
const fails = [];
const t0 = Date.now();
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; fails.push(name); console.log(`  FAIL  ${name}${extra ? "  " + extra : ""}`); }
};
const info = (name, extra = "") => console.log(`  INFO  ${name}${extra ? "  " + extra : ""}`);
const skipped = (name) => { skip++; console.log(`  SKIP  ${name}`); };

const steps = [];
const step = (name, fn) => steps.push({ name, fn });

// ──────────────────────────── CDP 通道 ────────────────────────────

const conn = { sock: null, id: 0, pend: new Map() };

/** 这个窗口是不是装着我们插件的那个 vault（只看 Goalscapes 目录在不在，不依赖插件当前是启用还是禁用） */
async function isGoalscapeVault(url) {
  const ws = new WebSocket(url);
  try {
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const r = await new Promise((res) => {
      ws.send(JSON.stringify({
        id: 1, method: "Runtime.evaluate",
        params: { expression: "!!(window.app&&window.app.vault&&window.app.vault.getAbstractFileByPath('Goalscapes'))", returnByValue: true },
      }));
      ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) res(m); };
      setTimeout(() => res(null), 4000);
    });
    return !!r?.result?.result?.value;
  } catch {
    return false;
  } finally {
    try { ws.close(); } catch { /* 已关就不管 */ }
  }
}

async function connect() {
  const pages = (await (await fetch(`${CDP}/json/list`)).json()).filter((x) => x.type === "page");
  if (!pages.length) throw new Error(`${CDP} 上没有页面：Obsidian 是否以 --remote-debugging-port=9333 启动？`);
  // 多 vault / 多窗口时 CDP 会把别的窗口排在第一个，选错页面只会得到"插件不存在"的假崩溃
  let page = pages[0];
  if (pages.length > 1) {
    const hits = [];
    for (const t of pages) if (await isGoalscapeVault(t.webSocketDebuggerUrl)) hits.push(t);
    if (!hits.length) throw new Error(`${pages.length} 个窗口里没有一个开着 Goalscapes 目录：${pages.map((t) => t.title).join(" | ")}`);
    page = hits[0];
  }
  conn.sock = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { conn.sock.onopen = res; conn.sock.onerror = rej; });
  conn.sock.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && conn.pend.has(m.id)) { conn.pend.get(m.id)(m); conn.pend.delete(m.id); }
  });
  // 页内等待原语：视图渲染在 mutate 的那一个 JS 任务里就同步跑完了，所以页内"等一下"
  // 其实只要等浏览器出两帧。跟调用方给的上限时间赛跑 —— 窗口被遮挡时 rAF 不回来，
  // 也就退化成原来那记固定等待，不会更久。
  await ev(`window.__gsSettle=(cap=400)=>new Promise(r=>{
    requestAnimationFrame(()=>requestAnimationFrame(()=>r(1)));setTimeout(()=>r(1),cap)})`);
}

function send(method, params = {}) {
  return new Promise((res) => {
    const k = ++conn.id;
    conn.pend.set(k, res);
    conn.sock.send(JSON.stringify({ id: k, method, params }));
    setTimeout(() => { if (conn.pend.has(k)) { conn.pend.delete(k); res({ __timeout: true }); } }, 40000);
  });
}

/** 页面里求值。异常和超时都抛出去：静默拿到 undefined 会让断言假绿 */
async function ev(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.__timeout) throw new Error(`CDP 无响应（窗口在前台吗？）：${expression.slice(0, 50)}`);
  const exc = r.result?.exceptionDetails;
  if (exc) throw new Error(`页面异常：${(exc.exception?.description || exc.text || "").split("\n")[0]}`);
  return r.result?.result?.value;
}
const json = async (expr) => JSON.parse(await ev(`(async()=>JSON.stringify(await (${expr})))()`));

async function waitFor(expr, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await ev(`!!(${expr})`)) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`等待超时（${timeout}ms）：${label}`);
}

const clickEl = (sel) => ev(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new MouseEvent('click',{bubbles:true}))`);

async function shot(name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const r = await send("Page.captureScreenshot", { format: "png" });
  if (!r.result?.data) throw new Error("截图失败");
  const file = path.join(SHOT_DIR, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(r.result.data, "base64"));
  return file;
}

const dirSnap = () => Object.fromEntries(
  fs.readdirSync(SCAPE_DIR)
    .filter((f) => !f.startsWith(`${TMP_NAME}.`))
    .map((f) => [f, `${fs.statSync(path.join(SCAPE_DIR, f)).size}@${Math.round(fs.statSync(path.join(SCAPE_DIR, f)).mtimeMs)}`])
);

// ──────────────────────────── 现场快照 / 还原 ────────────────────────────

const start = {};

async function snapshot() {
  start.path = await json(`${PL}.store.path`);
  start.theme = await ev(`app.getTheme()`);
  start.files = dirSnap();
  start.active = await json(`(()=>{const l=app.workspace.activeLeaf;
    return l?{type:l.view.getViewType(),file:l.view.file?l.view.file.path:null}:null;})()`);
}

async function restore() {
  const notes = [];
  try {
    // 先收临时白板的标签页，再删文件；最后把当前图切回起始值（switchGoalscape 会顺带写 data.json）
    await json(`(async()=>{
      const pl=${PL};
      for(const l of app.workspace.getLeavesOfType('canvas'))
        if(l.view.file?.path===${JSON.stringify(TMP_CANVAS)}) await l.detach();
      for(const l of app.workspace.getLeavesOfType('markdown'))
        if(l.view.file?.path?.startsWith(${JSON.stringify(`${NOTES_DIR}/`)})) await l.detach();
      for(const p of [${JSON.stringify(TMP_CANVAS)}, ${JSON.stringify(TMP_PATH)}]){
        const f=app.vault.getAbstractFileByPath(p); if(f) await app.vault.delete(f);
      }
      // 笔记目录得先掏空再删：vault.delete 对非空目录会 ENOTEMPTY
      const nd=app.vault.getAbstractFileByPath(${JSON.stringify(NOTES_DIR)});
      if(nd){ for(const c of [...(nd.children||[])]) await app.vault.delete(c); await app.vault.delete(nd); }
      if(pl.store.path!==${JSON.stringify(start.path)}) await pl.switchGoalscape(${JSON.stringify(start.path)});
      await __gsSettle(400);
      return pl.store.path;})()`);
    notes.push(`path=${start.path}`);
  } catch (e) { notes.push(`还原 store 失败：${e.message}`); }

  try {
    if (start.active) {
      await json(`(()=>{const want=${JSON.stringify(start.active)};
        const leaf=app.workspace.getLeavesOfType(want.type)
          .find(l=>want.file?l.view.file?.path===want.file:true);
        if(leaf) app.workspace.revealLeaf(leaf); return !!leaf;})()`);
      notes.push(`active=${start.active.file || start.active.type}`);
    }
  } catch (e) { notes.push(`还原活动标签失败：${e.message}`); }

  try { await ev(`app.changeTheme(${JSON.stringify(start.theme)})`); } catch { /* 主题还原失败无关紧要 */ }
  // 程序化改滑杆会留下 Obsidian 的动态 tooltip（真鼠标一动就没了，但截图里是块残渣）
  try { await ev(`document.querySelectorAll('.notice,.menu,.tooltip').forEach(n=>n.remove())`); } catch { /* ignore */ }

  const after = dirSnap();
  const added = Object.keys(after).filter((f) => !(f in start.files));
  const gone = Object.keys(start.files).filter((f) => !(f in after));
  const changed = Object.keys(after).filter((f) => start.files[f] && start.files[f] !== after[f]);
  ok("临时图与其白板已删除、目录清单回到起始状态", !added.length && !gone.length,
    `新增=${added.join(",") || "-"} 丢失=${gone.join(",") || "-"}`);
  if (changed.length) info("用户图在跑测期间被改动（多半是本人，未回滚）", changed.join(", "));
  info(`现场：${notes.join(" | ")}`);
}

/** canvas 步骤可单独跑：临时图不在就自己建一张，并把当前图钉在它上面 */
async function useTmpMap() {
  if (!(await json(`app.vault.adapter.exists(${JSON.stringify(TMP_PATH)})`))) {
    await json(`(async()=>{await ${PL}.createGoalscape(${JSON.stringify(TMP_NAME)}); return 1;})()`);
  }
  await ev(`${PL}.switchGoalscape(${JSON.stringify(TMP_PATH)})`);
  await waitFor(`${PL}.store.path===${JSON.stringify(TMP_PATH)}`, "钉在临时图上");
}

// ──────────────────────────── 步骤 ────────────────────────────

step("reload 插件并打开放射图", async () => {
  await json(`(async()=>{const p=app.plugins;
    await p.disablePlugin(${JSON.stringify(PLUGIN)}); await new Promise(r=>setTimeout(r,500));
    await p.enablePlugin(${JSON.stringify(PLUGIN)}); await new Promise(r=>setTimeout(r,500));
    await p.plugins[${JSON.stringify(PLUGIN)}].openView(${JSON.stringify(RADIAL)});
    return 1;})()`);
  await waitFor(`document.querySelector('.goalscape-toolbar')`, "工具栏出现");
  await waitFor(`document.querySelectorAll('svg.goalscape-radial-svg path[data-id]').length>1`, "放射图画出扇区");
  ok("插件重载后视图可用", true);
});

step("toolbar 单行且只剩切换与筛选", async () => {
  const bar = await json(`(()=>{const tb=document.querySelector('.goalscape-toolbar');
    return {parts:[...tb.children].map(e=>e.className.replace(/^goalscape-/,'')),
      h:Math.round(tb.getBoundingClientRect().height),
      text:tb.textContent.replace(/\\s+/g,' ').trim(),
      stale:document.querySelectorAll('.goalscape-actions,.goalscape-map-select,.goalscape-view-select,.goalscape-filter-wrap,.goalscape-filter-bar').length};})()`);
  ok("工具栏子元素=切换器/图名按钮/漏斗/浮层",
    bar.parts.join(",") === "view-switch,map-btn,filter-btn,filter-popover", bar.parts.join(","));
  ok("只有一行（高度 < 46px）", bar.h > 0 && bar.h < 46, `${bar.h}px`);
  ok("没有已移到右键菜单/目录栏的入口文案",
    !/New map|Subgoal|Sibling|Delete|Filter:/i.test(bar.text), JSON.stringify(bar.text));
  ok("旧版 select / 第二行筛选的类名无残留", bar.stale === 0, String(bar.stale));
});

step("view-switch 分段按钮单击切换", async () => {
  const segs = await json(`[...document.querySelectorAll('.goalscape-view-seg')].map(b=>({
    label:b.getAttribute('aria-label'), active:b.classList.contains('is-active'),
    shapes:b.querySelector('svg')?b.querySelectorAll('svg > *').length:0,
    w:Math.round(b.getBoundingClientRect().width)}))`);
  ok("段数=4、每段图标都解析出图形元素、宽度一致",
    segs.length === 4 && segs.every((s) => s.shapes > 0 && s.w >= 20 && s.w <= 30),
    segs.map((s) => `${s.label}:${s.shapes}@${s.w}`).join(" "));
  ok("恰好一段高亮", segs.filter((s) => s.active).length === 1, segs.map((s) => s.active).join(","));

  const cycle = await json(`(async()=>{
    const out=[];
    for(const want of ['Goal list','Gantt','Radial map']){
      [...document.querySelectorAll('.goalscape-view-seg')].find(b=>b.getAttribute('aria-label')===want)
        .dispatchEvent(new MouseEvent('click',{bubbles:true}));
      await new Promise(r=>setTimeout(r,500));
      const tabs=${JSON.stringify(VIEW_TYPES)}.reduce((n,t)=>n+app.workspace.getLeavesOfType(t).length,0);
      out.push({want, tabs,
        active:[...document.querySelectorAll('.goalscape-view-seg.is-active')].map(b=>b.getAttribute('aria-label')).join(','),
        painted:!!(document.querySelector('.goalscape-list-row')||document.querySelector('.goalscape-gantt-root')
          ||document.querySelector('svg.goalscape-radial-svg'))});
    }
    return out;})()`);
  ok("连切三种呈现方式全程只有 1 个 Goalscape 标签", cycle.every((c) => c.tabs === 1),
    cycle.map((c) => c.tabs).join(","));
  ok("高亮段始终等于当前视图、内容都画出来了",
    cycle.every((c) => c.active === c.want && c.painted), cycle.map((c) => `${c.want}→${c.active}`).join(" "));
});

step("map-menu 图文件名按钮与原生菜单", async () => {
  const current = await json(`${PL}.store.path`);
  const btn = await json(`(()=>{const b=document.querySelector('.goalscape-map-btn');
    return {text:b.textContent.trim(), shapes:b.querySelectorAll('svg > *').length,
      w:Math.round(b.getBoundingClientRect().width)};})()`);
  ok("按钮只显示当前图文件名 + 箭头",
    btn.text === current.split("/").pop().replace(/\.goalscape\.json$/, "") && btn.shapes > 0 && btn.w <= 160,
    JSON.stringify(btn));

  await ev(`document.querySelector('.goalscape-map-btn').dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:200,clientY:80}))`);
  await waitFor(`document.querySelector('.menu .menu-item')`, "图文件菜单展开");
  const menu = await json(`(()=>{const items=[...document.querySelectorAll('.menu .menu-item')];
    return {count:items.length, checked:items.filter(i=>/checked/.test(i.className)).map(i=>i.textContent.trim())};})()`);
  const maps = await json(`${PL}.listGoalscapes()`);
  ok("菜单列出全部图、且只给当前项打勾",
    menu.count === maps.length && menu.checked.length === 1 && menu.checked[0] === btn.text,
    JSON.stringify(menu));

  const others = maps.filter((p) => p !== current);
  if (!others.length) { skipped("只有一张图，跳过切图断言"); return; }
  const target = others[0];
  const targetName = target.split("/").pop().replace(".goalscape.json", "");

  const switched = await json(`(async()=>{
    const pl=${PL}; const v=pl.radialViews()[0];
    const id=[...document.querySelectorAll('svg.goalscape-radial-svg path[data-id]')]
      .map(p=>p.getAttribute('data-id')).find(x=>x!==pl.store.scape.mainGoal.id);
    v.select(id); await __gsSettle(300);
    const withSel=document.querySelector('.goalscape-panel').textContent.trim();
    [...document.querySelectorAll('.menu .menu-item')].find(i=>i.textContent.trim()===${JSON.stringify(targetName)})
      .dispatchEvent(new MouseEvent('click',{bubbles:true}));
    await new Promise(r=>setTimeout(r,600));
    return {withSel, after:document.querySelector('.goalscape-panel').textContent.trim(),
      path:pl.store.path, label:document.querySelector('.goalscape-map-btn').textContent.trim(),
      menuGone:!document.querySelector('.menu')};})()`);
  ok("切图后按钮标签同步、菜单关闭",
    switched.path === target && switched.label === targetName && switched.menuGone, JSON.stringify(switched));
  ok("换图清空上一张图的选中（面板不出现 not found）",
    /Importance/.test(switched.withSel) && !/not found/i.test(switched.after),
    JSON.stringify({ withSel: switched.withSel.slice(0, 24), after: switched.after.slice(0, 34) }));

  await ev(`${PL}.switchGoalscape(${JSON.stringify(current)})`);
  await waitFor(`${PL}.store.path===${JSON.stringify(current)}`, "切回原图");
});

step("filter 漏斗浮层筛选", async () => {
  const first = await json(`(()=>{const b=document.querySelector('.goalscape-filter-btn'),p=document.querySelector('.goalscape-filter-popover');
    return {shapes:b.querySelectorAll('svg > *').length, closedAtFirst:!p.offsetParent};})()`);
  ok("漏斗图标解析成功、浮层默认收起", first.shapes > 0 && first.closedAtFirst, JSON.stringify(first));

  await clickEl(".goalscape-filter-btn");
  await waitFor(`document.querySelector('.goalscape-filter-popover').offsetParent`, "浮层展开");
  const panel = await json(`(()=>{const p=document.querySelector('.goalscape-filter-popover'),b=document.querySelector('.goalscape-filter-btn');
    const types={}; for(const i of p.querySelectorAll('input')) types[i.type||'text']=(types[i.type||'text']||0)+1;
    return {types, clear:!!p.querySelector('.goalscape-filter-clear'),
      below:p.getBoundingClientRect().top>=b.getBoundingClientRect().bottom-4,
      w:Math.round(p.getBoundingClientRect().width)};})()`);
  ok("浮层控件=1 文本 + 2 数字 + 1 颜色 + Clear",
    JSON.stringify(panel.types) === JSON.stringify({ text: 1, number: 2, color: 1 }) && panel.clear,
    JSON.stringify(panel.types));
  ok("浮层展开在工具栏下方且宽度受限", panel.below && panel.w > 150 && panel.w < 400, JSON.stringify(panel));

  const dim = await json(`(async()=>{
    const tag=document.querySelector('.goalscape-filter-tag');
    tag.value='zzz-no-such-tag'; tag.dispatchEvent(new Event('change',{bubbles:true}));
    await __gsSettle(400);
    return {dimmed:document.querySelectorAll('svg.goalscape-radial-svg path[data-id].goalscape-dimmed').length,
      all:document.querySelectorAll('svg.goalscape-radial-svg path[data-id]').length,
      sheen:document.querySelectorAll('svg.goalscape-radial-svg .goalscape-bevel.goalscape-dimmed').length,
      dot:document.querySelector('.goalscape-filter-btn').classList.contains('is-active')};})()`);
  // 光源叠层也要一起变淡，否则未命中的格子上还留着一圈亮边把眼睛勾过去
  ok("无匹配标签 → 全图降饱和（含光源叠层）+ 漏斗亮圆点",
    dim.all > 0 && dim.dimmed === dim.all && dim.sheen === dim.all && dim.dot, JSON.stringify(dim));

  const away = await json(`(async()=>{
    document.querySelector('svg.goalscape-radial-svg').dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:500,clientY:400}));
    await __gsSettle(300);
    return {closed:!document.querySelector('.goalscape-filter-popover').offsetParent,
      dot:document.querySelector('.goalscape-filter-btn').classList.contains('is-active'),
      dimmed:document.querySelectorAll('svg.goalscape-radial-svg path.goalscape-dimmed').length};})()`);
  ok("点浮层外只关面板、筛选条件仍生效", away.closed && away.dot && away.dimmed > 0, JSON.stringify(away));

  const toggle = await json(`(async()=>{
    const b=document.querySelector('.goalscape-filter-btn');
    b.dispatchEvent(new MouseEvent('click',{bubbles:true})); await __gsSettle(250);
    const open=!!document.querySelector('.goalscape-filter-popover').offsetParent;
    b.dispatchEvent(new MouseEvent('click',{bubbles:true})); await __gsSettle(250);
    return {open, closedAgain:!document.querySelector('.goalscape-filter-popover').offsetParent};})()`);
  ok("再点漏斗：先开后关（捕获阶段的点外面判定没抢关）", toggle.open && toggle.closedAgain, JSON.stringify(toggle));

  const cleared = await json(`(async()=>{
    document.querySelector('.goalscape-filter-btn').dispatchEvent(new MouseEvent('click',{bubbles:true}));
    await __gsSettle(250);
    document.querySelector('.goalscape-filter-clear').dispatchEvent(new MouseEvent('click',{bubbles:true}));
    await __gsSettle(400);
    return {dimmed:document.querySelectorAll('svg.goalscape-radial-svg path.goalscape-dimmed').length,
      dot:document.querySelector('.goalscape-filter-btn').classList.contains('is-active'),
      tag:document.querySelector('.goalscape-filter-tag').value,
      open:!!document.querySelector('.goalscape-filter-popover').offsetParent};})()`);
  ok("Clear 归零：不降饱和、圆点消失、输入清空、面板保持展开",
    cleared.dimmed === 0 && !cleared.dot && cleared.tag === "" && cleared.open, JSON.stringify(cleared));
});

step("file-menu 目录栏右键新建图", async () => {
  const folder = await json(`(async()=>{
    const title=[...document.querySelectorAll('.nav-folder-title')]
      .find(e=>e.textContent.trim()===${JSON.stringify(SCAPE_DIR_NAME)});
    if(!title) return {err:'目录栏里找不到 ${SCAPE_DIR_NAME} 文件夹（可能被折叠）'};
    const r=title.getBoundingClientRect();
    title.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:r.left+30,clientY:r.top+8}));
    await new Promise(r=>setTimeout(r,500));
    return {items:[...document.querySelectorAll('.menu .menu-item')].map(i=>i.textContent.trim())};})()`);
  if (folder.err) { skipped(folder.err); return; }
  const clicked = await json(`(()=>{const i=[...document.querySelectorAll('.menu .menu-item')]
    .find(x=>x.textContent.trim()==='New goalscape');
    if(i){i.dispatchEvent(new MouseEvent('click',{bubbles:true})); return 1;} return 0;})()`);
  ok("文件夹右键菜单含 New goalscape 且可点", clicked === 1, folder.items.join(" / "));

  await waitFor(`document.querySelector('.modal input')`, "新建图弹窗");
  const created = await json(`(async()=>{
    const modal=document.querySelector('.modal');
    const input=modal.querySelector('input');
    input.value=${JSON.stringify(TMP_NAME)}; input.dispatchEvent(new Event('input',{bubbles:true}));
    [...modal.querySelectorAll('button')].find(b=>b.textContent.trim()==='Confirm').dispatchEvent(new MouseEvent('click',{bubbles:true}));
    await new Promise(r=>setTimeout(r,800));
    const raw=await app.vault.adapter.read(${JSON.stringify(TMP_PATH)});
    return {bytes:raw.length, valid:JSON.parse(raw).mainGoal?.title||'',
      path:${PL}.store.path,
      label:document.querySelector('.goalscape-map-btn').textContent.trim(),
      active:app.workspace.activeLeaf.view.getViewType(),
      sectors:document.querySelectorAll('svg.goalscape-radial-svg path[data-id]').length};})()`);
  ok(`新建落在 ${SCAPE_DIR_NAME}/ 下且 JSON 可用`, created.bytes > 50 && !!created.valid, JSON.stringify(created));
  ok("建完自动打开放射图、工具栏标签切到新图",
    created.active === RADIAL && created.label === TMP_NAME && created.path === TMP_PATH && created.sectors > 1,
    JSON.stringify(created));
});

// ───────────── 白板镜像：树 → .canvas 单向、自动、保住手工布局 ─────────────

/** Canvas 段的 data-view 就是 viewTypes 里的 VIEW_CANVAS（按界面文案找会被 "Canvas (白板)" 这种叫法带偏） */
const CANVAS_SEG = ".goalscape-view-seg[data-view='goalscape-canvas-file']";
/** 后台标签页里的工具栏是 display:none，宽度量出来是 0 —— 优先取看得见的那个段 */
const segState = () => json(`(()=>{const all=[...document.querySelectorAll(${JSON.stringify(CANVAS_SEG)})];
  const b=all.find(e=>e.offsetParent)||all[0];
  return {stale:b.classList.contains('is-stale'), w:Math.round(b.getBoundingClientRect().width),
    active:b.classList.contains('is-active')};})()`);
const backToRadial = () => json(`(async()=>{const l=app.workspace.getLeavesOfType(${JSON.stringify(RADIAL)})[0];
  app.workspace.revealLeaf(l); await __gsSettle(400); return 1;})()`);
/** 每次点击前都重新钉住当前图：用户本人可能正在应用里切图，不钉就会拿到别人的树 */
const clickCanvasSeg = async () => {
  await useTmpMap();
  await clickEl(CANVAS_SEG);
  await new Promise((r) => setTimeout(r, 300));
};
const readScape = () => json(`(async()=>{try{
  return JSON.parse(await app.vault.adapter.read(${JSON.stringify(TMP_PATH)}));}catch{return null;}})()`);
/** 文件有没有被碰过：镜像"内容一致就不写"这条只能靠 mtime+大小验 */
const canvasStamp = () => {
  const s = fs.statSync(path.join(SCAPE_DIR, `${TMP_NAME}.canvas`));
  return `${s.size}@${Math.round(s.mtimeMs)}`;
};

step("canvas 段：开着只切过去、关掉标签页才补写", async () => {
  await useTmpMap();
  await setTmpTree(GRID);
  await resetCanvas();

  await clickCanvasSeg();
  const first = await waitCanvasDoc((d) => d.nodes.length === 4, "第一次点 Canvas 建出四张卡");
  ok("白板文件不存在时，Canvas 段生成第一版并打开标签页",
    first.nodes.every((n) => typeof n.gsId === "string") && first.edges.length === 3,
    JSON.stringify({ nodes: first.nodes.length, edges: first.edges.map((e) => e.id) }));

  // 标签页开着的时候改树：canvas 视图的内存领先磁盘几十秒，这时硬写会被它的补写盖掉 —— 只能欠着
  await setTmpTree(GRID_PLUS);
  await new Promise((r) => setTimeout(r, 1500)); // 防抖 800ms 早就过了
  const held = await readCanvasDoc();
  ok("白板标签页开着时不写盘（欠着而不是盖掉）",
    !held.nodes.some((n) => n.id === "g-c"), JSON.stringify(held.nodes.map((n) => n.id)));
  await backToRadial(); // 回到放射图这一侧，工具栏才看得见、量得出宽度
  const lit = await segState();
  ok("欠着更新时 Canvas 段上有小点，且段按钮宽度没被撑开",
    lit.stale === true && lit.w >= 20 && lit.w <= 30, JSON.stringify(lit));
  info("小点亮着的样子", await shot("canvas-stale-dot"));

  await clickCanvasSeg();
  const tabs = await json(`app.workspace.getLeavesOfType('canvas')
    .filter(l=>l.view.file?.path===${JSON.stringify(TMP_CANVAS)}).length`);
  const still = await readCanvasDoc();
  ok("再点 Canvas 只切过去：标签页不重复堆叠、也没趁机写盘",
    tabs === 1 && !still.nodes.some((n) => n.id === "g-c"), `${tabs} tabs`);

  // 关掉标签页正是补写的时机（视图关闭时自己会先把内存那份落盘，我们的写在它后面）
  await closeCanvasTabs();
  const settled = await waitCanvasDoc((d) => d.nodes.some((n) => n.id === "g-c"), "关掉标签页后补写");
  ok("关掉白板标签页后自动补上欠着的那次，连线按新树接",
    settled.edges.some((e) => e.id === "e-g-c" && e.fromNode === "g-b" && e.toNode === "g-c"),
    JSON.stringify(settled.edges.map((e) => `${e.id}:${e.fromNode}>${e.toNode}`)));
  const off = await segState();
  ok("补写之后小点消失", off.stale === false, JSON.stringify(off));

  const view = await json(`({
    radial:app.workspace.getLeavesOfType(${JSON.stringify(RADIAL)}).length,
    active:[...document.querySelectorAll('.goalscape-view-seg.is-active')].map(b=>b.getAttribute('aria-label')).join(','),
    canvasTabs:app.workspace.getLeavesOfType('canvas').filter(l=>l.view.file?.path===${JSON.stringify(TMP_CANVAS)}).length})`);
  ok("本标签页的视图与高亮不被 Canvas 段改动（它不是第四种呈现方式）",
    view.radial === 1 && view.active === "Radial map" && view.canvasTabs === 0, JSON.stringify(view));
});

// ───────────── 白板镜像的测试脚手架（合成树 + 读写白板的轮询原语） ─────────────

/** 层级够简单、又足够让"加孩子/改名"看得出结果的小树；id 前缀 g- 免得和别的步骤的 n- 混起来 */
const GRID = {
  id: "g-root", title: "Root", importance: 100, tags: [], children: [
    { id: "g-a", title: "Alpha", importance: 60, tags: [], children: [
      { id: "g-a1", title: "Alpha-1", importance: 100, tags: [], children: [] },
    ] },
    { id: "g-b", title: "Bravo", importance: 40, tags: [], children: [] },
  ],
};

/** 长出一个孩子：镜像必须给 g-c 补一张卡，同时不碰别的卡片位置 */
const GRID_PLUS = structuredClone(GRID);
GRID_PLUS.children[1].children = [{ id: "g-c", title: "Charlie", importance: 100, tags: [], children: [] }];

const gsCommand = (id) => ev(`app.commands.executeCommandById(${JSON.stringify(`${PLUGIN}:${id}`)})`);
const closeCanvasTabs = async () => {
  await json(`(async()=>{
    for(const l of app.workspace.getLeavesOfType('canvas'))
      if(l.view.file?.path===${JSON.stringify(TMP_CANVAS)}) await l.detach(); return 1;})()`);
  // 摘页不等于内存文档死了：Obsidian 还会把那份没有手工改动的文档补写一次，先等它落完
  await new Promise((r) => setTimeout(r, 400));
};
/** adapter.write 会先截断再写（实测有 0 字节瞬时读），所以按内容谓词轮询而不是读一次就算 */
const readCanvasDoc = () => json(`(async()=>{try{
  const d=JSON.parse(await app.vault.adapter.read(${JSON.stringify(TMP_CANVAS)}));
  return d&&Array.isArray(d.nodes)?d:null;}catch{return null;}})()`);
async function waitCanvasDoc(pred, label) {
  for (let k = 0; k < 80; k++) {
    const d = await readCanvasDoc();
    if (d && pred(d)) return d;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(`等白板内容超时：${label}`);
}
/** 开着的白板标签页里的内存文档（Obsidian 自己解析过的那份）：文件写对了不代表它认得未知键 */
async function waitLiveCanvasDoc(pred, label) {
  for (let k = 0; k < 80; k++) {
    const d = await json(`(()=>{const l=app.workspace.getLeavesOfType('canvas')
        .find(x=>x.view.file?.path===${JSON.stringify(TMP_CANVAS)});
      const c=l?.view?.canvas; return c&&typeof c.getData==='function'?c.getData():null;})()`);
    if (d && pred(d)) return d;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(`等白板内存文档超时：${label}`);
}
const writeCanvasDoc = (doc) => json(`(async()=>{
  const f=app.vault.getAbstractFileByPath(${JSON.stringify(TMP_CANVAS)});
  if(!f) throw new Error('临时白板不存在');
  await app.vault.modify(f, ${JSON.stringify(JSON.stringify(doc))}); return 1;})()`);
/** 手工改白板：写完必须验到，验不到就再写一次 —— 补写的那一次可能正好落在 modify 之后 */
async function putCanvasDoc(doc, pred, label) {
  for (let k = 0; k < 4; k++) {
    await writeCanvasDoc(doc);
    for (let i = 0; i < 12; i++) {
      const d = await readCanvasDoc();
      if (d && pred(d)) return d;
      await new Promise((r) => setTimeout(r, 60));
    }
  }
  throw new Error(`手工写的白板内容没能留住：${label}`);
}
/** 白板是命令的输入也是它的输出：先关掉标签页再删文件，别留一份内存文档回头盖掉磁盘 */
const resetCanvas = async () => {
  await closeCanvasTabs();
  await json(`(async()=>{const f=app.vault.getAbstractFileByPath(${JSON.stringify(TMP_CANVAS)});
    if(f) await app.vault.delete(f); return 1;})()`);
};
const setTmpTree = (tree) => json(`(async()=>{${PL}.store.mutate(s=>{s.mainGoal=${JSON.stringify(tree)};});
  await __gsSettle(400); return 1;})()`);

step("mirror 自动镜像：不用点命令也更新，手工布局与便签都保住", async () => {
  await useTmpMap();
  await setTmpTree(GRID);
  await resetCanvas();
  const delAt = Date.now();
  await new Promise((r) => setTimeout(r, 1300)); // 防抖 800ms 过了一整轮
  const canvasState = await json(`(async()=>{
    const p=${JSON.stringify(TMP_CANVAS)};
    const ex=await app.vault.adapter.exists(p);
    const f=app.vault.getAbstractFileByPath(p);
    return JSON.stringify({
      exists: ex,
      bytes: f && f.stat ? f.stat.size : null,
      sinceDeleteMs: Date.now() - ${delAt},
      head: ex ? (await app.vault.adapter.read(p)).slice(0, 70) : null,
      auto: ${PL}.canvas?.auto ?? null,
      stale: ${PL}.canvas?.stale ?? null,
      tabs: app.workspace.getLeavesOfType("canvas").length,
    });})()`);
  ok("白板文件还不存在时，改树不会凭空往 vault 里扔文件",
    JSON.parse(canvasState).exists === false, canvasState);

  await gsCommand("export-canvas");
  const first = await waitCanvasDoc((d) => d.nodes.length === 4, "首次导出四张卡片");
  ok("首次导出：每张卡带 gsId，连线是 e-<子目标> 这种可认的 id",
    first.nodes.every((n) => typeof n.gsId === "string")
      && first.edges.map((e) => e.id).sort().join(",") === "e-g-a,e-g-a1,e-g-b",
    JSON.stringify({ nodes: first.nodes.length, edges: first.edges.map((e) => e.id) }));

  // "靠机器字段认卡片"成不成立，取决于 Obsidian 自己的解析器留不留这个键 —— 这里当场验一次
  await waitFor(`app.workspace.getLeavesOfType('canvas').some(l=>l.view.file?.path===${JSON.stringify(TMP_CANVAS)})`, "白板标签页打开");
  const live = await waitLiveCanvasDoc((d) => Array.isArray(d.nodes) && d.nodes.length === 4, "内存文档四张卡片");
  ok("Obsidian 内存里的白板文档认得 gsId（未知键被原样留住）",
    live.nodes.every((n) => typeof n.gsId === "string"),
    JSON.stringify(live.nodes.map((n) => `${n.id}:${n.gsId ?? "-"}`)).slice(0, 200));

  await closeCanvasTabs();
  // 用户自己摆的：把 g-a 挪远放大，再加一张便签和一条牵到树上的线
  await putCanvasDoc({
    ...first,
    nodes: [...first.nodes.map((n) => (n.id === "g-a" ? { ...n, x: 9999, y: -8888, width: 444, height: 222 } : n)),
      { id: "zz-sticky", type: "text", x: 1400, y: 900, width: 200, height: 120, text: "手工便签" }],
    edges: [...first.edges, { id: "zz-edge", fromNode: "g-a", toNode: "zz-sticky" }],
  }, (d) => d.nodes.some((n) => n.id === "zz-sticky" && n.x === 1400), "便签写进白板");

  // 只改数据、不点任何命令：加一个孩子 g-c，并把 g-b 改名
  const renamed = structuredClone(GRID_PLUS);
  renamed.children[1].title = "Bravo 改名";
  await setTmpTree(renamed);
  const second = await waitCanvasDoc((d) => d.nodes.some((n) => n.id === "g-c"), "改树后白板自己补上新目标卡片");
  const movedA = second.nodes.find((n) => n.id === "g-a");
  ok("改树约 1 秒内白板自己更新（全程没点命令）",
    second.nodes.length === 6 && second.nodes.some((n) => n.gsId === "g-c"),
    JSON.stringify(second.nodes.map((n) => n.id)));
  ok("再生成不会把布局挪动：手工摆的坐标与尺寸原样保留",
    movedA?.x === 9999 && movedA?.y === -8888 && movedA?.width === 444 && movedA?.height === 222,
    JSON.stringify(movedA));
  ok("卡片文字跟着树走：改名后新标题写进原来那张卡，且只有一张",
    /Bravo 改名/.test(second.nodes.find((n) => n.id === "g-b")?.text || "")
      && second.nodes.filter((n) => n.gsId === "g-b").length === 1,
    JSON.stringify(second.nodes.find((n) => n.id === "g-b")?.text));
  ok("便签和它牵到树上的那条线不动",
    second.nodes.some((n) => n.id === "zz-sticky") && second.edges.some((e) => e.id === "zz-edge"),
    `${second.nodes.length}n/${second.edges.length}e`);
  ok("新目标按新树连好（e-g-c 挂在 g-b 下）",
    second.edges.some((e) => e.id === "e-g-c" && e.fromNode === "g-b" && e.toNode === "g-c"),
    JSON.stringify(second.edges.map((e) => `${e.id}:${e.fromNode}>${e.toNode}`)));

  await new Promise((r) => setTimeout(r, 700));
  const stamp = canvasStamp();
  await new Promise((r) => setTimeout(r, 1500)); // 树没再动，这一轮该一次都不写
  const stamp2 = canvasStamp();
  ok("内容一致就不再碰文件（幂等：再生成不会反复重写）", stamp === stamp2, `${stamp} → ${stamp2}`);

  // 树里删掉一个目标：它的卡片跟着消失，但用户的便签不能连坐
  // "卡片消失"这种减法条件对旧文件也成立，所以先等文件真的被改写过再验内容
  const preStamp = canvasStamp();
  const minus = structuredClone(renamed);
  minus.children[1].children = [];
  await setTmpTree(minus);
  for (let k = 0; k < 40 && canvasStamp() === preStamp; k++) await new Promise((r) => setTimeout(r, 60));
  const third = await waitCanvasDoc((d) => !d.nodes.some((n) => n.id === "g-c"), "删掉的目标卡片消失");
  ok("树里删掉的目标，它的卡片与连线一起消失",
    !third.edges.some((e) => e.toNode === "g-c" || e.fromNode === "g-c"), JSON.stringify(third.nodes.map((n) => n.id)));
  ok("没认领目标的便签不会被连坐删掉",
    third.nodes.some((n) => n.id === "zz-sticky") && third.edges.some((e) => e.id === "zz-edge"),
    `${third.nodes.length}n/${third.edges.length}e`);
  await closeCanvasTabs();
});

step("mirror 只往一个方向走：白板里的改动不回写数据", async () => {
  await useTmpMap();
  await setTmpTree(GRID);
  await resetCanvas();
  await gsCommand("export-canvas");
  const base = await waitCanvasDoc((d) => d.nodes.length === 4, "单向验证用的白板");
  await closeCanvasTabs();
  const before = await readScape();

  // 旧版"从白板同步"会吃的三样改动：换父箭头 + 改卡片文字 + 挪位置
  await putCanvasDoc({
    ...base,
    nodes: base.nodes.map((n) => (n.id === "g-b" ? { ...n, x: 3000, y: 3000, text: "**白板里改的名字**" } : n)),
    edges: base.edges.map((e) => (e.id === "e-g-a1" ? { ...e, fromNode: "g-b" } : e)),
  }, (d) => d.nodes.find((n) => n.id === "g-b")?.x === 3000
    && d.edges.find((e) => e.id === "e-g-a1")?.fromNode === "g-b", "白板里的三样改动");

  await new Promise((r) => setTimeout(r, 1800)); // 防抖窗口过去两轮：镜像没有任何理由动
  const now = await readScape();
  ok("白板改箭头/改文字/挪位置 → 数据树一个字节都不动",
    JSON.stringify(now?.mainGoal) === JSON.stringify(before.mainGoal),
    JSON.stringify(now?.mainGoal)?.slice(0, 160));

  // 下一次镜像按树纠正回来：结构与文字跟树走，位置跟白板走
  await setTmpTree(GRID_PLUS);
  const after = await waitCanvasDoc((d) => d.nodes.some((n) => n.id === "g-c"), "下一次镜像");
  const b = after.nodes.find((n) => n.id === "g-b");
  ok("白板里改的父子箭头会被树纠正回来（方向只有树 → 白板）",
    after.edges.find((e) => e.id === "e-g-a1")?.fromNode === "g-a",
    JSON.stringify(after.edges.map((e) => `${e.id}:${e.fromNode}>${e.toNode}`)));
  ok("卡片文字回到树里的标题，手工挪的位置仍然保住",
    /Bravo/.test(b?.text || "") && !/白板里改的名字/.test(b?.text || "") && b?.x === 3000 && b?.y === 3000,
    JSON.stringify(b));
  await closeCanvasTabs();
});

step("settings 自动更新白板开关", async () => {
  await json(`(async()=>{const pl=${PL}; if(!pl.canvasAuto) pl.setCanvasAuto(true); return 1;})()`);
  await useTmpMap();
  await setTmpTree(GRID);
  await resetCanvas();
  await gsCommand("export-canvas");
  await waitCanvasDoc((d) => d.nodes.length === 4, "开关验证用的白板");
  await closeCanvasTabs();

  const readSaved = () => json(`(async()=>{try{
    return JSON.parse(await app.vault.adapter.read('.obsidian/plugins/${PLUGIN}/data.json'));}catch{return null;}})()`);
  async function waitSaved(v) {
    for (let k = 0; k < 60; k++) {
      if ((await readSaved())?.canvasAuto === v) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }
  /** Obsidian 的 toggle 就是 input.checkbox-toggle，点一下翻一次；等到插件真收下值为止，不重复点 */
  const flip = (want) => json(`(async()=>{const pl=${PL};
    const rows=[...document.querySelectorAll('.modal .setting-item')].filter(e=>e.offsetParent);
    const t=rows.map(e=>e.querySelector('input[type=checkbox]')).find(Boolean);
    if(!t) throw new Error('设置页里没有开关：'+JSON.stringify(rows.map((e)=>e.querySelector('.setting-item-name')?.textContent)));
    t.click();
    for(let k=0;k<60&&pl.canvasAuto!==${want};k++) await new Promise(r=>setTimeout(r,50));
    return {auto:pl.canvasAuto, rows:rows.length,
      name:rows.find(e=>e.querySelector('input[type=checkbox]'))?.querySelector('.setting-item-name')?.textContent.trim()};})()`);

  await json(`(async()=>{app.setting.close(); app.setting.open();
    app.setting.openTabById(${JSON.stringify(PLUGIN)}); await __gsSettle(500); return 1;})()`);
  const off = await flip(false);
  ok("设置页第三个可见项就是「自动更新白板」，点它插件立刻收到关掉",
    off.rows === 3 && /白板/.test(off.name || "") && off.auto === false, JSON.stringify(off));
  ok("开关状态写进 data.json（重启插件还在）", await waitSaved(false), JSON.stringify(await readSaved()));

  await setTmpTree(GRID_PLUS);
  const offStamp = canvasStamp();
  await new Promise((r) => setTimeout(r, 1600));
  const held = await readCanvasDoc();
  ok("关掉之后改树：白板停在原来的样子，一次都不写",
    canvasStamp() === offStamp && !held.nodes.some((n) => n.id === "g-c"),
    `${offStamp} → ${canvasStamp()}`);
  ok("关掉之后小点也不该亮着（没有待更新可言）", (await segState()).stale === false,
    JSON.stringify(await segState()));

  const on = await flip(true);
  await waitCanvasDoc((d) => d.nodes.some((n) => n.id === "g-c"), "开关回到开后补写").catch(() => null);
  const caught = await readCanvasDoc();
  ok("重新打开后立刻把欠着的那次补上（不用等下一次改动）",
    on.auto === true && caught.nodes.some((n) => n.id === "g-c"), JSON.stringify(caught.nodes.map((n) => n.id)));
  ok("开关回到开后 data.json 也跟着改回来", await waitSaved(true), JSON.stringify(await readSaved()));
  await json(`(async()=>{app.setting.close(); return ${PL}.canvasAuto;})()`);
});

/** 刻意不对称的合成树：分支深度不同、环厚不同、兄弟和既有 <100（留白）也有 >100（溢出） */
const FOREST = {
  title: "Root", importance: 100, children: [
    { title: "Thick", importance: 40, bandScale: 1.3, children: [
      { title: "A1", importance: 30, children: [{ title: "A1a", importance: 50 }, { title: "A1b", importance: 50 }] },
      { title: "A2", importance: 20 },
    ] },
    { title: "Over", importance: 25, children: [{ title: "B1", importance: 90 }, { title: "B2", importance: 90 }] },
    // 长标题 + 只占 8% 角度：必然画不下，用来验截断；再一个 1.5% 的连字都放不下，验悬停兜底
    { title: "长期主义的身体与财务健康储备", importance: 8 },
    { title: "极窄也要有个名字的小目标", importance: 1.5 },
    { title: "Thin", importance: 10, bandScale: 0.6, children: [
      { title: "C1", importance: 100, bandScale: 0.6, children: [
        { title: "C2", importance: 100, bandScale: 0.6, children: [
          { title: "C3", importance: 100, bandScale: 0.6, children: [{ title: "C4", importance: 100 }] },
        ] },
      ] },
    ] },
    { title: "Zero", importance: 0, children: [{ title: "Z1", importance: 100 }] },
  ],
};

/** 标题即 id（这棵树里标题唯一），断言里可以直接写 shapes['n-A1'] */
function toGoalNode(n) {
  return {
    id: `n-${n.title}`, title: n.title, importance: n.importance,
    ...(n.bandScale ? { bandScale: n.bandScale } : {}),
    ...(n.color ? { color: n.color } : {}),
    ...(n.progress !== undefined ? { progress: n.progress } : {}),
    tags: [], children: (n.children || []).map(toGoalNode),
  };
}

step("forest 递归几何：留白 / 每节点环厚 / 不溢出 / 标签截断", async () => {
  await useTmpMap();
  const tree = await json(`(async()=>{
    const pl=${PL};
    pl.store.mutate(s=>{s.mainGoal=${JSON.stringify(toGoalNode(FOREST))};});
    // 不用等：mutate → notify → render 是同一个 JS 任务里同步跑完的
    const v=pl.radialViews()[0];
    const shapes={}; for(const [id,s] of v.nodePositions) shapes[id]={rIn:Math.round(s.rInner),rOut:Math.round(s.rOuter),span:+(s.endAngle-s.startAngle).toFixed(4)};
    const bbox=document.querySelector('svg.goalscape-radial-svg').getBBox();
    // 标签到底有没有画在自己那块扇区里：拿浏览器真实排出来的包围盒（不是代码里的字宽估算），
    // 四个角映回用户坐标逐角比半径和角度。上一版"预算按弧长、字却沿半径写"就是这么露馅的。
    const svg=document.querySelector('svg.goalscape-radial-svg');
    const toUser=svg.getScreenCTM().inverse();
    const spill=[], modes={};
    for(const t of svg.querySelectorAll('text.goalscape-label[data-id]')){
      const id=t.getAttribute('data-id'), s=v.nodePositions.get(id);
      modes[t.getAttribute('data-mode')]=(modes[t.getAttribute('data-mode')]||0)+1;
      if(!s) continue;
      const m=toUser.multiply(t.getScreenCTM()), b=t.getBBox(), mid=(s.startAngle+s.endAngle)/2;
      let out=0;
      for(const [x,y] of [[b.x,b.y],[b.x+b.width,b.y],[b.x,b.y+b.height],[b.x+b.width,b.y+b.height]]){
        const p=new DOMPoint(x,y).matrixTransform(m), r=Math.hypot(p.x-500,p.y-500);
        if(r<s.rInner-1||r>s.rOuter+1){out++;break;}
        let d=Math.atan2(p.y-500,p.x-500)-mid;
        while(d>Math.PI)d-=Math.PI*2; while(d<-Math.PI)d+=Math.PI*2;
        if(Math.abs(d)>(s.endAngle-s.startAngle)/2+0.01){out++;break;}
      }
      if(out)spill.push(id+'（'+t.textContent+'）');
    }
    return {shapes,bbox:{x:Math.round(bbox.x),y:Math.round(bbox.y),w:Math.round(bbox.width),h:Math.round(bbox.height)},
      spill,modes,
      labels:[...document.querySelectorAll('.goalscape-label')].map(t=>t.textContent),
      sectors:[...document.querySelectorAll('svg.goalscape-radial-svg path[data-id]')]
        .map(p=>({id:p.getAttribute('data-id'),tip:p.querySelector('title')?.textContent||''}))};})()`);
  const s = tree.shapes;
  const span = (id) => s[`n-${id}`]?.span ?? -1;
  const deg = (x) => Math.round((x * 180) / Math.PI);

  ok("importance 0 的节点不画扇区", !("n-Zero" in s) && !("n-Z1" in s), Object.keys(s).join(","));
  ok("兄弟和 50% → 父扇区留一半空白（Thick 下 A1+A2 = 40°，父 80°）",
    Math.abs(span("A1") + span("A2") - span("Thick") / 2) < 1e-3,
    `${deg(span("A1"))}+${deg(span("A2"))} vs 父 ${deg(span("Thick"))}`);
  ok("兄弟和 180% → 整体缩回、恰好铺满父扇区不越界",
    Math.abs(span("B1") + span("B2") - span("Over")) < 1e-3 && Math.abs(span("B1") - span("B2")) < 1e-6,
    `${deg(span("B1"))}/${deg(span("B2"))} vs 父 ${deg(span("Over"))}`);
  ok("子环内径 = 父环外径（逐节点递推，不再等宽）",
    s["n-A1"].rIn === s["n-Thick"].rOut, `${s["n-A1"].rIn} vs ${s["n-Thick"].rOut}`);
  ok("每节点自己的环厚生效：厚档分支比薄档分支的同层半径大",
    s["n-A1"].rOut > s["n-C1"].rOut, `A1 ${s["n-A1"].rOut} > C1 ${s["n-C1"].rOut}`);
  ok("层与层互不对齐（各分支半径独立）",
    s["n-A1"].rOut !== s["n-C1"].rOut && s["n-A1a"].rOut !== s["n-C2"].rOut,
    `A1 ${s["n-A1"].rOut} / C1 ${s["n-C1"].rOut} · A1a ${s["n-A1a"].rOut} / C2 ${s["n-C2"].rOut}`);
  ok("最深一条链仍铺在 viewBox 内（getBBox 不越 0..1000）",
    tree.bbox.x >= 0 && tree.bbox.y >= 0 && tree.bbox.x + tree.bbox.w <= 1000 && tree.bbox.y + tree.bbox.h <= 1000,
    JSON.stringify(tree.bbox));
  const truncated = tree.labels.filter((t) => t.endsWith("…"));
  ok("画不下的长标题截断成省略号（而不是整格空白）", truncated.length > 0, JSON.stringify(tree.labels));
  ok("标签的渲染包围盒全在自己扇区里（不捅出外径、不压到隔壁分支）",
    tree.spill.length === 0, tree.spill.join(" | "));
  ok("顺环写和沿半径写两种都用上了（宽扇区不再被环带厚度卡住字数）",
    tree.modes.tangential > 0 && tree.modes.radial > 0, JSON.stringify(tree.modes));
  // 根节点会画两行（标题 + 百分比），所以不能拿 label 数和 sector 数比大小，按内容判
  const narrow = tree.shapes["n-极窄也要有个名字的小目标"];
  ok("1.5% 的细条连 11px 的字高都放不下 → 不写字，但扇区仍在、<title> 全名也在（悬停可辨）",
    !!narrow && !tree.labels.some((t) => t.includes("极窄")),
    `span=${((narrow?.span ?? 0) * 180 / Math.PI).toFixed(1)}°`);
  ok("每个扇区都带 <title> 全名",
    tree.sectors.every((s) => s.tip.startsWith(s.id.replace(/^n-/, ""))),
    JSON.stringify(tree.sectors.filter((s) => !s.tip.startsWith(s.id.replace(/^n-/, ""))).slice(0, 2)));

  // 命中测试：环带半径逐节点不同，只能按扇区自己的 [rIn,rOut] 判 —— 拿深链上的扇区中心点真点一次
  const hit = await json(`(async()=>{
    const v=${PL}.radialViews()[0];
    const sh=v.nodePositions.get('n-C3');
    const mid=(sh.startAngle+sh.endAngle)/2, r=(sh.rInner+sh.rOuter)/2;
    const svg=document.querySelector('svg.goalscape-radial-svg');
    const p=new DOMPoint(500+Math.cos(mid)*r,500+Math.sin(mid)*r).matrixTransform(svg.getScreenCTM());
    const el=document.elementFromPoint(p.x,p.y);
    el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:7,isPrimary:true,clientX:p.x,clientY:p.y}));
    el.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:7,isPrimary:true,clientX:p.x,clientY:p.y}));
    await __gsSettle(400);
    return {hit:el.getAttribute('data-id'), panel:document.querySelector('.goalscape-panel').textContent.trim().slice(0,20)};})()`);
  ok("深链扇区中心点能被命中并选中（命中测试按各自环带半径）",
    hit.hit === "n-C3" && hit.panel.includes("C3"), JSON.stringify(hit));

  const band = await json(`(async()=>{
    const pl=${PL}; const v=pl.radialViews()[0];
    const byTitle=(t)=>{let f=null;(function w(n){if(n.title===t)f=n;n.children.forEach(w);})(pl.store.scape.mainGoal);return f;};
    const row=()=>[...document.querySelectorAll('.goalscape-panel .setting-item')]
      .find(r=>r.querySelector('.setting-item-name')?.textContent==='Importance');
    const btns=(i)=>row().querySelectorAll('.goalscape-band-btn')[i];
    // 选一个没设过 bandScale 的扇区（Over），选中态是上一步 hit 测试留下的 C3，不能直接读面板
    const sh=v.nodePositions.get('n-Over');
    const mid=(sh.startAngle+sh.endAngle)/2, r=(sh.rInner+sh.rOuter)/2;
    const svg=document.querySelector('svg.goalscape-radial-svg');
    const p=new DOMPoint(500+Math.cos(mid)*r,500+Math.sin(mid)*r).matrixTransform(svg.getScreenCTM());
    const el=document.elementFromPoint(p.x,p.y);
    el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:9,isPrimary:true,clientX:p.x,clientY:p.y}));
    el.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:9,isPrimary:true,clientX:p.x,clientY:p.y}));
    await __gsSettle(400);

    const out={title:document.querySelector('.goalscape-panel-title').textContent,
      before:byTitle('Over').bandScale,
      activeAtStart:[...row().querySelectorAll('.goalscape-band-btn')].findIndex(b=>b.classList.contains('is-active'))};
    // 改厚度前先把每个扇区的内外径记下来：调一个块，只允许它自己和它的后代动，
    // 父块与别的分支必须原样（早先按"累计最厚链"归一 unit，改一处全图跟着变宽窄）
    const snap=()=>{const o={};for(const [id,s] of v.nodePositions)o[id]=[Math.round(s.rInner),Math.round(s.rOuter)];return o;};
    const shapesBefore=snap();
    btns(3).dispatchEvent(new MouseEvent('click',{bubbles:true})); await __gsSettle(400);
    out.thick=byTitle('Over').bandScale;
    const shapesThick=snap();
    out.moved=Object.keys(shapesThick).filter((k)=>shapesThick[k].join()!==(shapesBefore[k]||[]).join()).sort();
    btns(2).dispatchEvent(new MouseEvent('click',{bubbles:true})); await __gsSettle(400);
    out.back=byTitle('Over').bandScale;
    out.backToSame=snap()[ 'n-Root'].join()===shapesBefore['n-Root'].join() && byTitle('Over').bandScale===undefined;
    out.activeAfter=[...row().querySelectorAll('.goalscape-band-btn')].filter(b=>b.classList.contains('is-active')).length;
    out.count=row().querySelectorAll('.goalscape-band-btn').length;
    return out;})()`);
  ok("面板四档按钮：默认高亮标准档（第 3 个），最厚档写 >1 的值、回标准档删掉字段",
    band.title === "Over" && band.count === 4 && band.before === undefined && band.activeAtStart === 2 &&
    band.thick > 1 && band.back === undefined && band.activeAfter === 1 && band.backToSame, JSON.stringify(band));
  ok("调一个块的环厚只影响它自己和它的后代，父块与别的分支不变",
    band.moved.join(",") === "n-B1,n-B2,n-Over", JSON.stringify(band.moved));

  await ev(`app.workspace.revealLeaf(app.workspace.getLeavesOfType(${JSON.stringify(RADIAL)})[0])`);
  await new Promise((r) => setTimeout(r, 500));
  info(`森林几何截图：${await shot("forest")}`);
});

/** 两条配色分支 + 一条没配色；叶子进度铺满 0/50/100，底色饱和度和外缘进度条的断言才有可比性 */
const BRANCHES = {
  title: "Root", importance: 100, children: [
    { title: "Blue", importance: 60, color: "#38bdf8", children: [
      { title: "B-done", importance: 30, progress: 100 },
      { title: "B-zero", importance: 30, progress: 0 },
      { title: "B-mid", importance: 30, children: [{ title: "B-mid-leaf", importance: 100, progress: 50 }] },
    ] },
    { title: "Pink", importance: 30, color: "#f472b6", children: [
      { title: "P-leaf", importance: 100, progress: 20 },
    ] },
    { title: "Plain", importance: 10, children: [] },
  ],
};

/** #rrggbb → {h,s,l}（HSL）：只用来比较**两个渲染结果之间**的关系，不去对账"存进数据的那个 hex" */
function hsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [16, 8, 0].map((sh) => ((n >> sh) & 255) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = ((max + min) / 2) * 100;
  if (!d) return { h: 0, s: 0, l };
  const s = (l > 50 ? d / (2 - max - min) : d / (max - min)) * 100;
  const h = 60 * (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4);
  return { h, s, l };
}
/**
 * 色相是个环：0 与 359 相差 1，不能直接相减。容差 20 —— 底色由 OKLCH 生成，
 * 同一个 OKLCH 色相在不同明度下折算回 HSL 会漂十几度（绿色漂得最狠），但绝不会漂到隔壁分支那边去。
 */
const sameHue = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b)) < 20;
/** WCAG 相对亮度：层级阶梯只断言"谁比谁亮"，基调怎么调都不用改断言 */
function lum(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (s) => ((n >> s) & 255) / 255;
  return 0.2126 * ch(16) + 0.7152 * ch(8) + 0.0722 * ch(0);
}

/** 读当前画布上每个扇区的扁平底色（fill 现在是 url(#…) 的块内渐变，所以看 data-color）；调用方自己 return fills */
const FILLS = `const fills={};
    for(const p of document.querySelectorAll('svg.goalscape-radial-svg path[data-id]'))
      fills[p.getAttribute('data-id')]=p.getAttribute('data-color');`;
const hueMap = (f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, Math.round(hsl(v).h)]));
const byLum = (f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, `${v}/${lum(v).toFixed(3)}`]));

step("color 分支统一色：色系只在二级、其余层级调明度", async () => {
  await useTmpMap();

  const painted = await json(`(async()=>{
    ${PL}.store.mutate(s=>{s.mainGoal=${JSON.stringify(toGoalNode(BRANCHES))};});
    ${FILLS}
    return fills;})()`);
  const H = (id) => hsl(painted[id]);
  // 亮度只跟**同一条分支**的各层比：色相本身带明度校正（黄色天生比蓝色亮），
  // 跨色相比亮度量的不是层级，会把"绿色中心盘比蓝色分支亮"误判成阶梯坏了
  ok("同一条分支：同层的兄弟完全同色、逐层变亮",
    painted["n-B-done"] === painted["n-B-zero"]
      && lum(painted["n-Blue"]) < lum(painted["n-B-done"])
      && lum(painted["n-B-mid"]) < lum(painted["n-B-mid-leaf"]),
    JSON.stringify(byLum(painted)));
  // 容差 20：底色由 OKLCH 生成，同一个 OKLCH 色相折算回 HSL 会随浓淡漂十几度（绿色漂得最狠）
  ok("不同分支各自成色；没配色的分支与中心盘同属默认色系、但按自己的层级取浓淡",
    !sameHue(H("n-Blue").h, H("n-Pink").h) && sameHue(H("n-Pink").h, H("n-P-leaf").h)
      && sameHue(H("n-Plain").h, H("n-Root").h) && painted["n-Plain"] !== painted["n-Root"],
    JSON.stringify(hueMap(painted)));
  ok("进度不参与底色（同层 0% 与 100% 是同一个 hex）",
    painted["n-B-done"] === painted["n-B-zero"], `${painted["n-B-done"]} vs ${painted["n-B-zero"]}`);


  // map 里每个节点是"扇区 → 倒角 → 进度条"，按 DOM 顺序把装饰层归给最近的 data-id 扇区，
  // 不用给它们再挂一个 id
  const rim = await json(`(()=>{
    const lumOf=(hex)=>{const n=parseInt((hex||'#000000').slice(1),16);const c=(s)=>((n>>s)&255)/255;
      return 0.2126*c(16)+0.7152*c(8)+0.0722*c(0);};
    const out={}; let cur=null;
    for(const p of document.querySelectorAll('.goalscape-map > path')){
      if(p.hasAttribute('data-id')){ cur=p.getAttribute('data-id'); out[cur]={}; continue; }
      if(!cur) continue;
      if(p.classList.contains('goalscape-bevel')) out[cur].bevel=true;
      if(p.classList.contains('goalscape-rim')){
        const done=parseFloat(p.getAttribute('stroke-dasharray'));
        out[cur].ratio=p.getTotalLength()?done/p.getTotalLength():-1;
      }
    }
    // 块内明暗：每个扇区的 fill 必须指向本视图 defs 里的一个渐变，且两端一深一浅
    const ramps=[];
    for(const p of document.querySelectorAll('.goalscape-map > path[data-id]')){
      const m=(p.getAttribute('fill')||'').match(/^url\\(#(.+)\\)$/);
      if(!m){ ramps.push({id:p.getAttribute('data-id'),bad:p.getAttribute('fill')}); continue; }
      const g=document.getElementById(m[1]);
      if(!g||g.tagName!=='radialGradient'){ ramps.push({id:p.getAttribute('data-id'),missing:m[1]}); continue; }
      const stops=[...g.children].map(s=>s.getAttribute('stop-color'));
      ramps.push({id:p.getAttribute('data-id'),n:stops.length,
        units:g.getAttribute('gradientUnits'),
        dark:lumOf(stops[0]),light:lumOf(stops[stops.length-1]),
        flat:p.getAttribute('data-color'),mid:lumOf(p.getAttribute('data-color'))});
    }
    return {rims:out,
      rimCount:document.querySelectorAll('.goalscape-map > path.goalscape-rim').length,
      bevelCount:document.querySelectorAll('.goalscape-map > path.goalscape-bevel').length,
      sectors:document.querySelectorAll('.goalscape-map > path[data-id]').length,
      mapFilter:getComputedStyle(document.querySelector('.goalscape-map')).filter,
      stage:getComputedStyle(document.querySelector('.goalscape-radial-root')).backgroundImage.slice(0,22),
      ramps};})()`);
  const ratio = (id) => rim.rims[id] && rim.rims[id].ratio;
  ok("进度条画在扇区外缘：dash 占比即完成度（0/50/100 各归各）",
    Math.abs(ratio("n-B-zero")) < 0.01 && Math.abs(ratio("n-B-done") - 1) < 0.01
      && Math.abs(ratio("n-B-mid") - 0.5) < 0.02 && Math.abs(ratio("n-Blue") - 0.5) < 0.02,
    JSON.stringify({ zero: ratio("n-B-zero"), done: ratio("n-B-done"), mid: ratio("n-B-mid"), blue: ratio("n-Blue") }));
  ok("每个块自己有明暗：fill 指向本视图的 userSpaceOnUse 渐变，内缘深、外缘浅，中间值就是 data-color",
    rim.ramps.every((r) => !r.bad && !r.missing) && rim.ramps.length === rim.sectors
      && rim.ramps.every((r) => r.n === 3 && r.units === "userSpaceOnUse" && r.dark < r.mid && r.mid < r.light),
    JSON.stringify(rim.ramps.slice(0, 3)));
  ok("每个扇区一道外缘倒角 + 一条进度条（没走到的地方不留轨道）",
    rim.sectors === rim.bevelCount && rim.sectors === rim.rimCount,
    JSON.stringify({ sectors: rim.sectors, bevels: rim.bevelCount, rims: rim.rimCount }));
  ok("整组一份柔和投影，且图后面垫了台面（否则黑投影落在近黑底色上没有落点）",
    /drop-shadow/.test(rim.mapFilter) && /radial-gradient/.test(rim.stage),
    JSON.stringify({ mapFilter: rim.mapFilter.slice(0, 40), stage: rim.stage }));
  // 截图前清掉选中：强调色描边和权重手柄会把进度条本身糊住
  await ev(`${PL}.radialViews()[0].clearSelection()`);
  await new Promise((r) => setTimeout(r, 350));
  info(`进度条 + 光源 + 投影截图：${await shot("progress-rim")}`);

  const panelAt = (id) => json(`(async()=>{
    const v=${PL}.radialViews()[0]; v.select(${JSON.stringify(id)});
    await __gsSettle(350);
    const p=document.querySelector('.goalscape-panel');
    return {title:p.querySelector('.goalscape-panel-title').textContent,
      names:[...p.querySelectorAll('.setting-item-name')].map(e=>e.textContent.trim()),
      swatches:p.querySelectorAll('.goalscape-color-swatches').length};})()`);
  const hub = await panelAt("n-Root");
  const branch = await panelAt("n-Blue");
  const deep = await panelAt("n-B-mid");
  ok("二级节点：有色系选择（取色器 + 色盘），没有明度滑杆",
    branch.title === "Blue" && branch.names.includes("Branch color")
      && !branch.names.includes("Brightness") && branch.swatches === 1,
    JSON.stringify(branch));
  ok("中心盘有自己的色系入口（只影响大盘），三级往内只剩明度滑杆",
    hub.title === "Root" && hub.names.includes("Hub color")
      && !hub.names.includes("Brightness") && hub.swatches === 1
      && deep.names.includes("Brightness") && !deep.names.some((n) => /color/i.test(n)) && deep.swatches === 0,
    JSON.stringify({ hub: hub.names, deep: deep.names }));

  const recolored = await json(`(async()=>{
    const v=${PL}.radialViews()[0]; v.select('n-Blue');
    await __gsSettle(350);
    // 点色盘第一格（取色器和 Auto 的 title 不是 hex），不写死 hex：色盘由 palette.ts 生成，会跟着基调变
    const sw=[...document.querySelectorAll('.goalscape-panel .goalscape-swatch')].find(s=>(s.title||'').startsWith('#'));
    const pickedHex=sw.title;
    sw.dispatchEvent(new MouseEvent('click',{bubbles:true}));
    await __gsSettle(600);
    ${FILLS}
    return {fills, pickedHex};})()`);
  const BLUE_IDS = ["n-Blue", "n-B-done", "n-B-zero", "n-B-mid", "n-B-mid-leaf"];
  ok("改二级节点一次：整条分支同一次渲染里一起变、别的分支一格像素都不动",
    BLUE_IDS.every((id) => recolored.fills[id] !== painted[id])
      && BLUE_IDS.every((id) => sameHue(hsl(recolored.fills[id]).h, hsl(recolored.fills["n-Blue"]).h))
      && recolored.fills["n-Pink"] === painted["n-Pink"] && recolored.fills["n-P-leaf"] === painted["n-P-leaf"],
    JSON.stringify({ before: hueMap(painted), after: hueMap(recolored.fills) }));
  ok("色盘上看到的颜色就是图上那一支的颜色（预设幂等，不会面板一个色、图上一个色）",
    recolored.fills["n-Blue"] === recolored.pickedHex, `${recolored.pickedHex} vs ${recolored.fills["n-Blue"]}`);

  await json(`(async()=>{
    const v=${PL}.radialViews()[0]; v.select('n-B-mid');
    await __gsSettle(350);
    const row=[...document.querySelectorAll('.goalscape-panel .setting-item')]
      .find(r=>r.querySelector('.setting-item-name')?.textContent.trim()==='Brightness');
    const el=row.querySelector('input[type=range]');
    el.value='-15';
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
    await __gsSettle(600);
    // 程序化拖动留下的动态 tooltip 会一直悬在界面上，把后面的截图糊一块
    document.querySelectorAll('.tooltip').forEach(t=>t.remove());
    return 1;})()`);
  const dimmed = await json(`(async()=>{
    ${FILLS}
    const row=[...document.querySelectorAll('.goalscape-panel .setting-item')]
      .find(r=>r.querySelector('.setting-item-name')?.textContent.trim()==='Brightness');
    let n=null; (function w(x){ if(x.id==='n-B-mid') n=x; x.children.forEach(w); })(${PL}.store.scape.mainGoal);
    return {fills, slider:row.querySelector('input[type=range]').value, brightness:n.brightness};})()`);
  ok("明度滑杆只压暗本节点：色相不变、子节点一格像素不受牵连",
    dimmed.slider === "-15" && dimmed.brightness === -15
      && lum(dimmed.fills["n-B-mid"]) < lum(recolored.fills["n-B-mid"])
      && dimmed.fills["n-B-mid-leaf"] === recolored.fills["n-B-mid-leaf"]
      && sameHue(hsl(dimmed.fills["n-B-mid"]).h, hsl(recolored.fills["n-B-mid"]).h),
    JSON.stringify({ slider: dimmed.slider, brightness: dimmed.brightness,
      mid: `${dimmed.fills["n-B-mid"]}/${lum(dimmed.fills["n-B-mid"]).toFixed(3)}`,
      leaf: dimmed.fills["n-B-mid-leaf"] }));

  const rehomed = await json(`(async()=>{
    ${PL}.store.mutate(s=>{
      const blue=s.mainGoal.children.find(c=>c.id==='n-Blue');
      const pink=s.mainGoal.children.find(c=>c.id==='n-Pink');
      pink.children.push(blue.children.splice(blue.children.findIndex(c=>c.id==='n-B-mid'),1)[0]);
    });
    await __gsSettle(600);
    ${FILLS}
    return fills;})()`);
  ok("挪到别的分支下自动跟新分支的色相（旧色值根本不存在，无需同步）",
    sameHue(hsl(rehomed["n-B-mid"]).h, hsl(rehomed["n-Pink"]).h)
      && sameHue(hsl(rehomed["n-B-mid-leaf"]).h, hsl(rehomed["n-Pink"]).h)
      && !sameHue(hsl(rehomed["n-B-mid"]).h, hsl(recolored.fills["n-B-mid"]).h),
    JSON.stringify({ after: hueMap(rehomed), before: hueMap(recolored.fills) }));

  const onDisk = await json(`app.vault.adapter.read(${JSON.stringify(TMP_PATH)}).then(t=>JSON.parse(t))`);
  const withColor = [];
  (function walk(n, depth) {
    if ("color" in n) withColor.push(`${n.id}@${depth}`);
    n.children.forEach((c) => walk(c, depth + 1));
  })(onDisk.mainGoal, 0);
  ok("落盘的 JSON 里 color 只出现在二级节点（深层的死字段写盘前就清掉了）",
    withColor.sort().join(",") === "n-Blue@1,n-Pink@1", withColor.join(","));
});

step("settings 颜色基调两根滑杆", async () => {
  await useTmpMap();

  const r = await json(`(async()=>{
    const pl=${PL};
    pl.store.mutate(s=>{s.mainGoal=${JSON.stringify(toGoalNode(BRANCHES))};});
    await __gsSettle(600);
    app.setting.close(); app.setting.open(); app.setting.openTabById('goalscape-obsidian');
    await __gsSettle(500);
    // 设置模态框会把之前看过的标签页留在 DOM 里（只是 display:none），
    // 不按可见性筛就会捞到别人的 setting-item
    const rows=[...document.querySelectorAll('.modal .setting-item')].filter(e=>e.offsetParent);
    const names=rows.map(e=>e.querySelector('.setting-item-name')?.textContent.trim());
    const snap=()=>{const f={};for(const p of document.querySelectorAll('.goalscape-map > path[data-id]'))
      f[p.getAttribute('data-id')]=p.getAttribute('data-color');return f;};
    const keys=['intensity','contrast'];
    const orig={...pl.toneSettings};
    const readSaved=()=>app.vault.adapter.read('.obsidian/plugins/goalscape-obsidian/data.json').then((t)=>JSON.parse(t)).catch(()=>({}));
    // 落盘是异步的，而"真的存下来了"正是下面那条断言要验的东西，所以按条件等而不是等固定时长
    const pollSaved=async(p)=>{for(let k=0;k<40;k++){const d=await readSaved();if(p(d))return d;
      await new Promise((r)=>setTimeout(r,30));}return readSaved();};
    const set=async(i,v)=>{
      const el=rows[i]?.querySelector('input[type=range]');
      if(!el) throw new Error('第 '+i+' 行没有滑杆：'+JSON.stringify(rows.map((e)=>e.querySelector('.setting-item-name')?.textContent)));
      el.value=String(v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));
      // 不信"等两帧"：滑杆的 onChange 有自己的节流节奏，实测就会读到上一档的颜色。
      // 等到插件真收下这个值为止 —— 重画是同步的，所以条件一成立，下一次 snap() 就是新颜色。
      for(let k=0;k<90&&pl.toneSettings[keys[i]]!==v;k++) await new Promise((r)=>requestAnimationFrame(r));
      if(pl.toneSettings[keys[i]]!==v) throw new Error('滑杆 '+keys[i]+' 停在 '+pl.toneSettings[keys[i]]+'，没收到 '+v);
    };
    const a=snap();
    await set(0,0); const soft=snap();
    await set(0,100); const loud=snap();
    const savedLoud=await pollSaved((d)=>d?.tone?.intensity===100);
    await set(0,orig.intensity); const back=snap();
    const spread=(hex)=>{const n=parseInt(hex.slice(1),16),c=(s)=>((n>>s)&255)/255;
      const v=[c(16),c(8),c(0)];return Math.max(...v)-Math.min(...v);};
    const lumOf=(hex)=>{const n=parseInt(hex.slice(1),16),c=(s)=>((n>>s)&255)/255;
      return 0.2126*c(16)+0.7152*c(8)+0.0722*c(0);};
    // 第二根：层次调平缓，外圈与二级分支的亮度差要被压小，但不能反过来
    const gapBefore=lumOf(a['n-B-done'])-lumOf(a['n-Blue']);
    await set(1,0); const flat=snap();
    const gapFlat=lumOf(flat['n-B-done'])-lumOf(flat['n-Blue']);
    await set(1,100); const steep=snap();
    const gapSteep=lumOf(steep['n-B-done'])-lumOf(steep['n-Blue']);
    await set(1,orig.contrast);
    const savedFinal=await pollSaved((d)=>d?.tone?.intensity===orig.intensity
      &&d?.tone?.contrast===orig.contrast);
    app.setting.close();
    return {names, count:rows.length, orig, savedLoud, savedFinal,
      softer:spread(soft['n-Blue'])<spread(a['n-Blue']),
      louder:spread(loud['n-Blue'])>spread(a['n-Blue']),
      restored:Object.keys(a).filter((k)=>a[k]!==back[k]).length,
      flatter:gapFlat<gapBefore, steeper:gapSteep>gapBefore, ordered:gapFlat<gapBefore&&gapBefore<gapSteep};})()`);
  ok("设置页两根滑杆：浓艳度左右两端分别变灰/变艳，拖回原位图也原样",
    r.count === 3 && /intensity/i.test(r.names[0]) && /contrast/i.test(r.names[1])
      && r.softer && r.louder && r.restored === 0,
    JSON.stringify(r));
  ok("层次分明度：往左压小内外圈的亮度差、往右拉大，且不会把顺序调反",
    r.flatter && r.steeper && r.ordered, JSON.stringify(r));
  ok("滑杆位置写进 data.json（重启插件还在），且不会把 currentPath 顶掉",
    r.savedLoud?.tone?.intensity === 100
      && r.savedFinal?.tone?.intensity === r.orig.intensity
      && r.savedFinal?.tone?.contrast === r.orig.contrast
      && typeof r.savedFinal?.currentPath === "string",
    JSON.stringify({ orig: r.orig, loud: r.savedLoud?.tone, final: r.savedFinal?.tone }));
});

step("viewport 滚轮以光标为锚缩放 + 空白处平移 + 双击还原", async () => {
  await useTmpMap();
  await json(`(async()=>{const pl=${PL};
    pl.store.mutate(s=>{s.mainGoal=${JSON.stringify(toGoalNode(FOREST))};});
    await __gsSettle(400);
    const svg=document.querySelector('svg.goalscape-radial-svg');
    svg.__gsNode=1;  // 节点身份标记：缩放只改 viewBox，被重建过就查不到这个标记
    return 1;})()`);

  // 光标底下那个点的逻辑坐标：缩放前后应当纹丝不动，这是"锚在光标上"的全部含义
  const logicAt = (x, y) => json(`(()=>{const svg=document.querySelector('svg.goalscape-radial-svg');
    const q=new DOMPoint(${x},${y}).matrixTransform(svg.getScreenCTM().inverse());
    return {x:Math.round(q.x),y:Math.round(q.y)};})()`);
  const wheel = (x, y, deltaY) => json(`(()=>{const svg=document.querySelector('svg.goalscape-radial-svg');
    const e=new WheelEvent('wheel',{deltaY:${deltaY},clientX:${x},clientY:${y},bubbles:true,cancelable:true});
    svg.dispatchEvent(e);
    const top=document.elementFromPoint(${x},${y});
    return {vb:svg.getAttribute('viewBox'),size:svg.viewBox.baseVal.width,
      prevented:e.defaultPrevented,built:!!svg.__gsNode,
      hit:top?.getAttribute?.('data-id')||String(top&&top.tagName)};})()`);

  const anchor = await json(`(()=>{const svg=document.querySelector('svg.goalscape-radial-svg');
    const b=svg.querySelector('path[data-id="n-A1"]').getBoundingClientRect();
    const x=Math.round(b.x+b.width/2),y=Math.round(b.y+b.height/2);
    const q=new DOMPoint(x,y).matrixTransform(svg.getScreenCTM().inverse());
    return {x,y,logic:{x:Math.round(q.x),y:Math.round(q.y)}};})()`);
  const in1 = await wheel(anchor.x, anchor.y, -100);
  const moved = await logicAt(anchor.x, anchor.y);
  ok("滚轮被视图接管（没漏成面板滚动）", in1.prevented);
  ok("放大生效且没重建 svg（只改 viewBox）",
    in1.size < 1000 && in1.size > 0 && in1.built, JSON.stringify(in1));
  ok("光标底下的逻辑点没漂",
    Math.abs(moved.x - anchor.logic.x) <= 2 && Math.abs(moved.y - anchor.logic.y) <= 2,
    `缩放前 ${JSON.stringify(anchor.logic)} → 缩放后 ${JSON.stringify(moved)}`);
  ok("放大后命中测试仍对齐（同一点还落在 n-A1 上）", in1.hit === "n-A1", in1.hit);

  let lim = in1;
  for (let i = 0; i < 25; i++) lim = await wheel(anchor.x, anchor.y, -100);
  const [lx, ly, ls] = lim.vb.split(" ").map(Number);
  ok("放大夹在 8× 上限（再滚不会滚成像素）",
    Math.abs(lim.size - 1000 / 8) < 0.02 && Math.abs(ls - lim.size) < 0.02, `size=${lim.size}`);
  ok("极限视野仍在画布内", lx >= 0 && ly >= 0 && lx + ls <= 1000.01 && ly + ls <= 1000.01,
    `viewBox=${lim.vb}`);
  for (let i = 0; i < 25; i++) lim = await wheel(anchor.x, anchor.y, 100);
  ok("往回滚一定能正好回到整张图", lim.vb === "0.00 0.00 1000.00 1000.00", lim.vb);

  // 平移：先选中 n-A1（pointerdown + 同点 pointerup 走 reparent 的点击分支），再放大三格 ——
  // 1× 那档平移在数学上就是空操作（窗口夹在画布内、余量为零），不放大根本挪不动。
  const picked = await json(`(()=>{const svg=document.querySelector('svg.goalscape-radial-svg');
    const b=svg.querySelector('path[data-id="n-A1"]').getBoundingClientRect();
    const x=Math.round(b.x+b.width/2),y=Math.round(b.y+b.height/2);
    svg.querySelector('path[data-id="n-A1"]').dispatchEvent(
      new PointerEvent('pointerdown',{clientX:x,clientY:y,button:0,bubbles:true}));
    window.dispatchEvent(new PointerEvent('pointerup',{clientX:x,clientY:y,button:0}));
    return document.querySelectorAll('svg.goalscape-radial-svg path.goalscape-selected').length;})()`);
  for (let i = 0; i < 3; i++) await wheel(anchor.x, anchor.y, -100);
  // 找一个确实空白的 svg 角点当手势落点，并重新钉上"这张 svg 没被重建过"的标记（选中会 render 一次）
  const bg = await json(`(()=>{const svg=document.querySelector('svg.goalscape-radial-svg');
    svg.__gsNode=1;
    const r=svg.getBoundingClientRect();
    for(const [x,y] of [[r.x+4,r.y+4],[r.right-4,r.y+4],[r.x+4,r.bottom-4],[r.right-4,r.bottom-4]])
      if(document.elementFromPoint(x,y)===svg) return {x:Math.round(x),y:Math.round(y)};
    return null;})()`);
  ok("找得到 svg 空白处（平移手势的落点）", !!bg, JSON.stringify(bg));
  ok("空白以外能选中扇区", picked === 1, String(picked));
  if (!bg) return;

  // 一次完整的空白处手势：pointerdown → move → up →（浏览器一定补的）click
  const gesture = (dx, dy) => json(`(()=>{const svg=document.querySelector('svg.goalscape-radial-svg');
    const f=${JSON.stringify(bg)}, tx=f.x+${dx}, ty=f.y+${dy};
    const pe=(t,el,x,y)=>el.dispatchEvent(new PointerEvent(t,{clientX:x,clientY:y,button:0,bubbles:true}));
    pe('pointerdown',svg,f.x,f.y);
    pe('pointermove',window,(f.x+tx)/2,(f.y+ty)/2);
    pe('pointermove',window,tx,ty);
    pe('pointerup',window,tx,ty);
    svg.dispatchEvent(new MouseEvent('click',{bubbles:true}));
    return {vb:svg.getAttribute('viewBox'),built:!!svg.__gsNode,
      kept:document.querySelectorAll('svg.goalscape-radial-svg path.goalscape-selected').length};})()`);

  const vBefore = await json(`document.querySelector('svg.goalscape-radial-svg').getAttribute('viewBox')`);
  const pan = await gesture(-140, 90);
  ok("空白处拖动平移了视野", pan.vb !== vBefore, `${vBefore} → ${pan.vb}`);
  ok("平移不改数据、也不重建 svg（拖着手不会一卡一卡的）",
    pan.built && (await json(`${PL}.store.scape.mainGoal.children.length`)) === 6, JSON.stringify(pan));
  ok("平移收尾补的那次 click 没把选中清掉", pan.kept === 1, String(pan.kept));
  ok("空白处单击仍然清除选中（抑制只吃真平移那一下）", (await gesture(0, 0)).kept === 0);

  const edge = await gesture(-4000, 4000);
  const [ex, ey, es] = edge.vb.split(" ").map(Number);
  ok("顶到边界仍夹在画布内（拖不出丢图的视野）",
    ex >= 0 && ey >= 0 && ex + es <= 1000.01 && ey + es <= 1000.01, edge.vb);

  const reset = await json(`(()=>{const svg=document.querySelector('svg.goalscape-radial-svg');
    svg.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true}));
    return svg.getAttribute('viewBox');})()`);
  ok("双击空白处回到整张图", reset === "0.00 0.00 1000.00 1000.00", reset);
});

// ───────────── notes 融入：面板渲染态 / 块间弦线 / 白板派生卡片 ─────────────

/**
 * 真鼠标点：走 CDP 的 Input 域，不是页内 dispatchEvent。
 * 差别不是洁癖 —— 合成 click 会绕过浏览器的按下/抬起命中测试，"处理器在 pointerup 里
 * 把自己脚下那个元素拆了"这类 bug 在合成事件下永远是绿的（Edit / Add link / chip 跳转
 * 就因此在实机里全点不动，而回归报 14/14）。凡是验"按钮点得动吗"都必须走这里。
 */
async function realClick(sel, nth = 0) {
  const box = await json(`(()=>{const el=document.querySelectorAll(${JSON.stringify(sel)})[${nth}];
    if(!el) return null; const b=el.getBoundingClientRect();
    return b.width?{x:b.left+b.width/2,y:b.top+b.height/2}:null;})()`);
  if (!box) throw new Error(`realClick 找不到 ${sel}[${nth}]`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", {
      type, x: box.x, y: box.y, button: type === "mouseMoved" ? "none" : "left",
      clickCount: type === "mouseMoved" ? 0 : 1, pointerType: "mouse",
    });
    if (type === "mousePressed") await new Promise((r) => setTimeout(r, 40));
  }
  await ev(`__gsSettle(400)`);
}

/** 选中只能"真点一次扇区"：视图没留公开入口，走命中测试反而是更接近用户的验法。
 *  取 0.3 而非 0.5 的弧中点 —— 选中态的弦线和端点圆点正好落在弧中点上，会拦住这一击。
 *  钉住的笔记浮层盖在图的右缘，会替扇区接下这一击；点之前先把它摘掉，点完立刻还原 */
const selectSector = (id) => json(`(async()=>{
  const dock=document.querySelector('.goalscape-note-dock');
  if(dock) dock.style.display='none';
  const v=${PL}.radialViews()[0];
  const sh=v.nodePositions.get(${JSON.stringify(id)});
  if(!sh) return {ok:0};
  const a=sh.startAngle+(sh.endAngle-sh.startAngle)*0.3, r=(sh.rInner+sh.rOuter)/2;
  const svg=document.querySelector('svg.goalscape-radial-svg');
  const p=new DOMPoint(500+Math.cos(a)*r,500+Math.sin(a)*r).matrixTransform(svg.getScreenCTM());
  const el=document.elementFromPoint(p.x,p.y);
  el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:31,isPrimary:true,clientX:p.x,clientY:p.y}));
  el.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:31,isPrimary:true,clientX:p.x,clientY:p.y}));
  await __gsSettle(400);
  if(dock) dock.style.display='';
  return {ok:1,hit:el?.getAttribute?.('data-id')||String(el?.tagName)};})()`);

/** 点图外的空角：清除选中（零噪音那条判据的起点） */
const clearSelection = () => json(`(async()=>{
  const svg=document.querySelector('svg.goalscape-radial-svg');
  const b=svg.getBoundingClientRect();
  const x=b.left+4, y=b.top+4;
  const el=document.elementFromPoint(x,y);
  el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:32,isPrimary:true,clientX:x,clientY:y}));
  el.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:32,isPrimary:true,clientX:x,clientY:y}));
  el.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:x,clientY:y}));
  await __gsSettle(400);
  return document.querySelectorAll('svg.goalscape-radial-svg path.goalscape-selected').length;})()`);

const chordState = () => json(`(()=>({
  chords:[...document.querySelectorAll('svg.goalscape-radial-svg path.goalscape-chord')].map(c=>c.getAttribute('data-chord')),
  dots:document.querySelectorAll('svg.goalscape-radial-svg circle.goalscape-chord-dot').length,
  svgCards:document.querySelectorAll('svg.goalscape-radial-svg .goalscape-note-card').length,
  rendered:!!document.querySelector('.goalscape-notes-render'),
  ta:document.querySelectorAll('.goalscape-panel textarea').length,
  btn:document.querySelector('.goalscape-notes-toggle')?.textContent||null,
  fields:document.querySelectorAll('.goalscape-panel-fields').length,
  links:[...document.querySelectorAll('.goalscape-panel .goalscape-chip-main')].map(b=>b.textContent),
  heads:[...document.querySelectorAll('.goalscape-panel h4')].map(h=>h.textContent),
  unresolved:document.querySelectorAll('.goalscape-notes-render a.is-unresolved').length,
  internal:document.querySelectorAll('.goalscape-notes-render a.internal-link').length,
}))()`);

/**
 * 右缘笔记浮层。gapRight 量的是卡片右缘到"图 + 浮层"那层 wrapper 右缘的距离：
 * 贴边这条判据要的是它恒等于一个常数，跟选中哪个扇区无关（粘在块边上就会跟着角度跑）。
 */
const dockState = () => json(`(()=>{
  const wrap=document.querySelector('.goalscape-map-wrap').getBoundingClientRect();
  return [...document.querySelectorAll('.goalscape-note-dock .goalscape-note-card')].map(c=>{
    const b=c.getBoundingClientRect(), q=(s)=>c.querySelector(s)?.textContent??null;
    return{
      goal:c.getAttribute('data-goal'),
      title:q('.goalscape-note-card-title'),
      body:q('.goalscape-note-card-body'),
      file:q('.goalscape-note-card-file'),
      links:[...c.querySelectorAll('.goalscape-note-card-link')].map(r=>r.textContent),
      close:c.querySelectorAll('.goalscape-note-card-close').length,
      gapRight:Math.round(wrap.right-b.right),
      top:Math.round(b.top),left:Math.round(b.left),
      visible:b.width>60&&b.height>40,
    };});})()`);

step("notes：md 文件是唯一真相，笔记卡钉在视图右缘、可同时钉多张", async () => {
  await useTmpMap();
  // 链接目标现取 vault 里的一篇真笔记：写死名字的话，"解析得到"这件事就从来没被验过
  const note = await json(`(()=>{const f=app.vault.getMarkdownFiles()
    .find(f=>!f.path.startsWith(${JSON.stringify(`${SCAPE_DIR_NAME}/`)}));
    return f?{name:f.basename,path:f.path}:null;})()`);
  if (!note) { skipped("vault 里没有可链接的笔记，notes 步骤跳过"); return; }
  const NOTE = `${NOTES_DIR}/Alpha.md`;
  const BRAVO = `${NOTES_DIR}/Bravo.md`;

  // 树先摆成旧版的形状（正文塞在 JSON 的 notes 里），当场验迁移。
  // 块间关系不写在 JSON 里：它只能是 Alpha 正文那条 [[Bravo#计划]]，锚点还得原样传下去
  const TREE = {
    id: "g-nroot", title: "Notes Root", importance: 100, tags: [], children: [
      { id: "g-na", title: "Alpha", importance: 60, tags: ["Now"], children: [],
        notes: [
          `本周跑 5 公里，见 [[${note.name}]]，安排见 [[Bravo#计划]]`,
          "",
          "## 训练安排",
          "- 周一 5km 配速跑",
          "- 周四 间歇 400m × 6",
          "",
          "第二段不进摘要",
        ].join("\n") },
      { id: "g-nb", title: "Bravo", importance: 40, tags: [], children: [],
        notes: ["## 计划", "- 睡够 8 小时", "- 十一点前躺下"].join("\n") },
    ],
  };
  await setTmpTree(TREE);
  const migrated = await ev(`${PL}.notes.syncMap()`);
  const moved = await json(`(async()=>({
    path:${PL}.store.scape.mainGoal.children[0].note,
    legacy:${PL}.store.scape.mainGoal.children[0].notes,
    raw:await app.vault.adapter.read(${JSON.stringify(NOTE)})}))()`);
  ok("旧版塞在 JSON 里的正文被搬进 .md：树里只剩路径，文件头带 gsId",
    migrated === 2 && moved.path === NOTE && moved.legacy === undefined
      && moved.raw.startsWith("---\ngsId: g-na\n---"),
    JSON.stringify(moved).slice(0, 120));
  // 刚写出来的两个 .md 缓存还没解析完：关系必须自己追上，不能等用户再动一下
  await waitFor(
    `${PL}.notes.get('g-na')?.refs?.some(r=>r.goalId==='g-nb'&&r.anchor==='#计划')`,
    "笔记互引被解析成带锚点的块间关系"
  );
  ok("普通 vault 笔记的引用 goalId 为 null（是内容不是块间关系）",
    await ev(`${PL}.notes.get('g-na').refs.some(r=>r.path===${JSON.stringify(note.path)}&&r.goalId===null)`));
  await resetCanvas();

  // 常态零噪音：没选中、一张都没钉的时候，浮层必须是空的（卡片是笔记的镜子，不是装饰）
  const quiet = await dockState();
  ok("一个都没点过时浮层零噪音", quiet.length === 0, JSON.stringify(quiet));

  const sel = await selectSector("g-na");
  ok("点扇区选中 Alpha", sel.hit === "g-na", JSON.stringify(sel));
  const st = await chordState();
  ok("笔记正文走原生 MarkdownRenderer：解析得到的 wikilink 成可点内部链接",
    st.rendered && st.internal >= 1 && st.unresolved === 0, JSON.stringify(st));
  ok("面板没有可写副本：textarea 一个都不该有（编辑去原生编辑器）",
    st.ta === 0 && st.btn === "Open note", JSON.stringify(st));
  ok("Custom fields 整节已删：写不进也读不出的死洞不留着",
    !st.heads.includes("Custom fields") && st.fields === 0, JSON.stringify(st.heads));
  ok("选中时的弦线只画笔记互引出来的那一条",
    st.chords.join(",") === "g-nb" && st.dots === 2, JSON.stringify(st));

  // 卡片从 svg 里的"粘在扇区外侧"改成 HTML 浮层"钉在视图右缘"，两条判据各管一半
  const d1 = await dockState();
  ok("点一次就钉住一张卡，画在 svg 里那版彻底没了",
    d1.length === 1 && d1[0].goal === "g-na" && d1[0].visible && st.svgCards === 0,
    JSON.stringify(d1));
  ok("卡片贴视图右缘：离右边缘只剩浮层自己的内边距，且每张都有一个 × ",
    d1[0].gapRight >= 0 && d1[0].gapRight <= 40 && d1[0].close === 1, JSON.stringify(d1[0]));
  ok("卡片内容够多：块标题 + 正文摘要 + 链到的每一行 + 笔记文件名",
    d1[0].title === "Alpha" && /本周跑 5 公里/.test(d1[0].body || "")
      && !/\[\[|(^|\n)#/.test(d1[0].body || "") && d1[0].file === "Alpha.md" && d1[0].links.length === 2,
    JSON.stringify(d1[0].body));
  ok("链到的那一行写标题 + 锚点，内部 id 一个都不露",
    d1[0].links.some((t) => /Bravo#计划/.test(t))
      && !`${d1[0].title}${d1[0].links.join("")}`.includes("g-n"),
    JSON.stringify(d1[0].links));
  const bravoRow = d1[0].links.findIndex((t) => t.includes("Bravo"));
  ok("References chip 用标题 + 锚点，不是内部 id",
    st.heads.includes("References") && st.links.includes("Bravo#计划"), JSON.stringify(st.links));
  info("笔记面板截图", await shot("notes-panel"));

  // 选中态的笔记卡是这轮新加的观感，亮色下"白卡+黑投影"最容易糊成一团 → 两主题都留一张
  const altTheme = start.theme === "obsidian" ? "moonstone" : "obsidian";
  // changeTheme 会弹一条 "Changed theme" 通知，它正压在扇区上方：不清掉的话下一次真点落在通知上
  const noToast = () => ev(`document.querySelectorAll('.notice,.menu,.tooltip').forEach(n=>n.remove())`);
  await ev(`app.changeTheme(${JSON.stringify(altTheme)})`);
  await new Promise((r) => setTimeout(r, 800));
  await noToast();
  info("笔记面板截图（另一主题）", await shot("notes-panel-alt"));
  await ev(`app.changeTheme(${JSON.stringify(start.theme)})`);
  await new Promise((r) => setTimeout(r, 800));
  await noToast();

  // 真鼠标点浮层里那一行链接：卡片是选中态唯一的"笔记出口"，点不动就等于没做
  await realClick('.goalscape-note-card[data-goal="g-na"] .goalscape-note-card-link', bravoRow);
  await waitFor(
    `app.workspace.getLeavesOfType('markdown').some(l=>l.view.file?.path===${JSON.stringify(BRAVO)})`,
    "点卡片里的链接行把对端笔记打开"
  );
  ok("点带锚点的链接行跳到对方块的笔记（锚点交给 Obsidian 解析）", true);

  // 光标此刻正在 Bravo 的笔记里：命令要答得出"这篇笔记是谁的笔记"（反链面板答不了这个）
  await gsCommand("reveal-owning-block");
  await waitFor(`${PL}.radialViews()[0]?.selectedId==='g-nb'`, "命令把这篇笔记的所属块选中");
  ok("笔记里跑「跳到所属块」：放射图被带到前面并选中它自己的块", true);

  // "点击一次保持打开"：选中跳到 Bravo 之后 Alpha 那张不该跟着消失，而是并排多一张
  const d2 = await dockState();
  ok("再选一块是加一张卡不是换一张卡（可同时钉多张，按打开顺序）",
    d2.map((c) => c.goal).join(",") === "g-na,g-nb" && d2.every((c) => c.visible),
    JSON.stringify(d2.map((c) => [c.goal, c.gapRight])));
  ok("钉住的卡只认视图右缘：换选中块时上一张的位置一格都没动",
    d2[0].top === d1[0].top && d2[0].left === d1[0].left, JSON.stringify({ was: d1[0], now: d2[0] }));
  info("两张卡并排（图已让边）", await shot("notes-dock-two"));
  // 让边这条判据量的是"画出来的那张图"（.goalscape-map 的实际轮廓），不是 svg 的方框
  const fit = await json(`(()=>{const m=document.querySelector('.goalscape-map').getBoundingClientRect();
    const c=document.querySelector('.goalscape-note-dock .goalscape-note-card').getBoundingClientRect();
    return{gap:Math.round(c.left-m.right)};})()`);
  ok("图真的让出了边：卡片左缘落在最外圈扇区右边之外", fit.gap >= 0, JSON.stringify(fit));

  const back = await selectSector("g-nb");
  const bs = await chordState();
  ok("反链现扫得到引用方（A→B 之后选中 B 看得见 A，锚点落在 B 自己的笔记里）",
    back.hit === "g-nb" && bs.heads.includes("Referenced by") && bs.links.includes("Alpha#计划")
      && bs.chords.join(",") === "g-na", JSON.stringify({ back, ...bs }));

  await realClick(".goalscape-panel .goalscape-chip-main", 0);
  const jumped = await ev(`${PL}.radialViews()[0].selectedId`);
  ok("真鼠标点 Referenced by chip 跳选到引用方", jumped === "g-na", String(jumped));

  // References chip 那一头也得真点得动（上一轮"点不动"就发生在这排按钮上）。
  // 先把编辑器标签摘干净，否则"打开了"跟上一次点的区分不出来
  await ev(`app.workspace.getLeavesOfType('markdown').forEach(l=>l.detach())`);
  await realClick(".goalscape-panel .goalscape-chip-main", 0);
  await waitFor(
    `app.workspace.getLeavesOfType('markdown').some(l=>l.view.file?.path===${JSON.stringify(BRAVO)})`,
    "References chip 打开对方块的笔记"
  );
  ok("真鼠标点 References chip 跳到对方笔记（锚点由 Obsidian 解析）", true);

  // chip 点下去之后被打开的笔记抢走了可见标签页，放射图此刻宽度为 0，真点必然落空
  await ev(`app.workspace.revealLeaf(app.workspace.getLeavesOfType(${JSON.stringify(RADIAL)})[0])`);
  // 真鼠标点"打开笔记"：合成 click 会绕过命中测试，这个按钮正是上一轮"点不动"的案发现场
  await realClick(".goalscape-notes-toggle");
  await waitFor(
    `app.workspace.getLeavesOfType('markdown').some(l=>l.view.file?.path===${JSON.stringify(NOTE)})`,
    "笔记在原生编辑器里打开"
  );
  ok("点按钮把笔记交给 Obsidian 自己的编辑器", true);

  // 回到放射图，在"外部"改那个 .md：watch 去抖重建后，面板预览要跟着变
  await ev(`app.workspace.revealLeaf(app.workspace.getLeavesOfType(${JSON.stringify(RADIAL)})[0])`);
  await selectSector("g-na");
  await json(`(async()=>{const f=app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)});
    await app.vault.modify(f,${JSON.stringify(`---\ngsId: g-na\n---\n\n改过之后的一句话，见 [[${note.name}]] 与 [[Bravo#计划]]\n`)});
    return 1;})()`);
  await waitFor(
    `document.querySelector('.goalscape-notes-render')?.textContent.includes('改过之后的一句话')`,
    "外部编辑的笔记正文回到面板预览"
  );
  const after = await chordState();
  ok("改完还是渲染态、没有偷偷长出编辑框", after.ta === 0 && after.rendered === true, JSON.stringify(after));
  ok("关系跟着正文变：改完的笔记里那条互引还在图上",
    after.chords.join(",") === "g-nb", JSON.stringify(after.chords));
  const d3 = await dockState();
  ok("外部改过正文后钉着的那张卡换成新摘要（卡片是镜子，不是按下那一刻的快照）",
    d3[0]?.goal === "g-na" && /改过之后的一句话/.test(d3[0].body || ""), JSON.stringify(d3[0]));

  // 取消选中：弦线这类"选中才画"的东西收走，但用户主动钉住的卡留着 —— 这就是"点一次保持打开"
  const selected = await clearSelection();
  const noise = await chordState();
  const d4 = await dockState();
  ok("取消选中后图面回到干净：没有选中扇区、没有弦线、没有端点圆点",
    selected === 0 && !noise.chords.length && noise.dots === 0, JSON.stringify({ selected, ...noise }));
  ok("取消选中不清空钉住的笔记卡",
    d4.map((c) => c.goal).join(",") === "g-na,g-nb", JSON.stringify(d4.map((c) => c.goal)));

  // × 只收自己那一张
  await realClick('.goalscape-note-card[data-goal="g-na"] .goalscape-note-card-close');
  const d5 = await dockState();
  ok("点 × 关掉那一张，另一张不受影响",
    d5.map((c) => c.goal).join(",") === "g-nb", JSON.stringify(d5.map((c) => c.goal)));
  await realClick('.goalscape-note-card[data-goal="g-nb"] .goalscape-note-card-close');
  ok("关到最后一张时浮层整个消失（常态零噪音）", (await dockState()).length === 0);

  await gsCommand("export-canvas");
  const doc1 = await waitCanvasDoc(
    (d) => d.edges.some((e) => e.id.startsWith(`n-g-na-`)) && d.edges.some((e) => e.id === "x-g-na-g-nb"),
    "白板长出笔记卡与链接边"
  );
  const filesOf = (d, id) =>
    d.nodes.filter((n) => n.type === "file" && n.id.startsWith(`f-${id}-`)).map((n) => n.gsFile);
  ok("白板里笔记有影子：这块自己的笔记就算正文空着也镜像成一张 file 卡",
    filesOf(doc1, "g-na")[0] === NOTE && filesOf(doc1, "g-nb")[0] === BRAVO,
    JSON.stringify({ a: filesOf(doc1, "g-na"), b: filesOf(doc1, "g-nb") }));
  ok("自己的笔记排第一张，笔记里链到的普通文件接着排",
    filesOf(doc1, "g-na").join(",") === [NOTE, note.path].join(","), JSON.stringify(filesOf(doc1, "g-na")));
  // 文件卡与它的边共用同一段后缀（f-<块>-<hash> / n-<块>-<hash>），照后缀配对比在测试里重算 hash 稳
  const suffixOf = (s) => s.split("-").slice(1).join("-");
  ok("file 卡各带一条 n- 边连回自己的目标卡、且都不带 gsId（它们不是目标卡，不许抢认领）",
    doc1.nodes.filter((n) => n.type === "file").every((f) => {
      const e = doc1.edges.find((x) => x.id.startsWith("n-") && suffixOf(x.id) === suffixOf(f.id));
      return e && e.toNode === f.id;
    }) && doc1.nodes.filter((n) => n.type === "file").every((n) => n.gsId === undefined),
    JSON.stringify(doc1.edges.filter((e) => e.id.startsWith("n-")).map((e) => e.id)));
  ok("块间链接边是 x-<from>-<to> 且带 🔗",
    doc1.edges.some((e) => e.id === "x-g-na-g-nb" && e.label === "🔗"),
    JSON.stringify(doc1.edges.find((e) => e.id === "x-g-na-g-nb")));
  const cardA = doc1.nodes.find((n) => n.gsId === "g-na");
  ok("卡片摘要来自 .md 的第一行，且不再有 #tags 那一行",
    /改过之后的一句话/.test(cardA?.text || "") && !/#Now/.test(cardA?.text || ""),
    JSON.stringify(cardA?.text));

  // 文件卡要 Obsidian 自己的解析器认得才算真长在了白板上（文件写对不代表它接得住 type:file）
  await waitFor(`app.workspace.getLeavesOfType('canvas').some(l=>l.view.file?.path===${JSON.stringify(TMP_CANVAS)})`, "白板标签页打开（导出命令会点开它）");
  const live = await waitLiveCanvasDoc((d) => d.nodes.some((n) => n.type === "file"), "内存文档里的笔记卡");
  ok("Obsidian 内存文档接得住 type:file 与 gsFile 未知键",
    live.nodes.some((n) => n.type === "file" && n.gsFile === note.path),
    JSON.stringify(live.nodes.map((n) => `${n.id}:${n.type}`)).slice(0, 200));
  await closeCanvasTabs();

  // 重新钉一张：接下来验的是"笔记文件没了，钉着的卡要自己掉出去"（卡片是笔记的镜子，不是快照）
  await ev(`app.workspace.revealLeaf(app.workspace.getLeavesOfType(${JSON.stringify(RADIAL)})[0])`);
  await selectSector("g-na");
  ok("关掉过的块再点一次能重新钉上", (await dockState()).map((c) => c.goal).join(",") === "g-na",
    JSON.stringify(await dockState()));

  // 笔记文件被用户删掉：这块就是没有笔记，插件不许把它写回来
  await json(`(async()=>{const f=app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)});
    await app.vault.delete(f); return 1;})()`);
  await waitFor(`${PL}.notes.get('g-na')===undefined`, "删掉笔记文件后索引里这一块空出来");
  ok("用户删掉笔记文件后插件没有偷偷重建",
    !(await json(`app.vault.adapter.exists(${JSON.stringify(NOTE)})`)));
  await waitFor(
    `document.querySelectorAll('.goalscape-note-dock .goalscape-note-card').length===0`,
    "笔记文件删了，钉着的那张卡自己掉出浮层"
  );
  ok("笔记文件没了，钉着的卡不留在图上指认一篇不存在的笔记", true);

  const cut = structuredClone(TREE);
  delete cut.children[0].notes;
  delete cut.children[1].notes;
  await setTmpTree(cut);
  // 界面上没有"把笔记从块上摘下来"这个动作，抹掉 note 路径只有手改 JSON 一条路；
  // 索引只在开图/换图/文件事件时重建，这里就照用户真会走的那条路补一次
  await ev(`${PL}.notes.syncMap()`);
  const doc2 = await waitCanvasDoc(
    (d) => !d.nodes.some((n) => n.type === "file") && !d.edges.some((e) => e.id === "x-g-na-g-nb"),
    "链接与笔记摘掉后派生卡消失"
  );
  ok("链接没了：下一轮镜像把笔记卡和链接边一起收走（不留僵尸）",
    !doc2.nodes.some((n) => n.type === "file") && !doc2.edges.some((e) => e.id.startsWith("x-")),
    JSON.stringify({ nodes: doc2.nodes.map((n) => n.type), edges: doc2.edges.map((e) => e.id) }));
});

step("themes 暗/亮两主题截图", async () => {
  await json(`(async()=>{
    const pl=${PL};
    if(pl.store.path!==${JSON.stringify(start.path)}) await pl.switchGoalscape(${JSON.stringify(start.path)});
    await __gsSettle(400);
    app.workspace.revealLeaf(app.workspace.getLeavesOfType(${JSON.stringify(RADIAL)})[0]);
    await __gsSettle(300);
    document.querySelector('.goalscape-filter-btn').dispatchEvent(new MouseEvent('click',{bubbles:true}));
    return 1;})()`);
  await waitFor(`document.querySelector('.goalscape-filter-popover').offsetParent`, "浮层展开（截图用）");
  const other = start.theme === "obsidian" ? "moonstone" : "obsidian";
  const dark = await shot(`toolbar-${start.theme}`);
  await ev(`app.changeTheme(${JSON.stringify(other)})`);
  await new Promise((r) => setTimeout(r, 800));
  const light = await shot(`toolbar-${other}`);
  await ev(`app.changeTheme(${JSON.stringify(start.theme)})`);
  info(`截图：${dark} / ${light}`);
  ok("两种主题都截到帧", fs.statSync(dark).size > 1000 && fs.statSync(light).size > 1000);
});

// ──────────────────────────── 主流程 ────────────────────────────

try {
  await connect();
  await snapshot();
  info(`起始：path=${start.path} theme=${start.theme} active=${start.active?.file || start.active?.type}`);
  for (const s of steps) {
    if (!wanted(s.name)) continue;
    console.log(`\n=== ${s.name} ===`);
    try { await s.fn(); }
    catch (e) { fail++; fails.push(`${s.name}（步骤抛错）`); console.log(`  ERROR ${e.message}`); }
    // 步骤抛错时它自己开的模态框会留着，把后面几步（尤其是也要开模态框的）全带崩；
    // 程序化拖滑杆留下的动态提示也会一直悬着、糊在后面的截图里。所以每步跑完无条件收一次场。
    try {
      await ev(`(()=>{app.setting?.close?.();
        document.querySelectorAll('.notice,.menu,.tooltip').forEach(n=>n.remove()); return 1;})()`);
    } catch { /* 收不掉就算了 */ }
  }
} catch (e) {
  fail++; fails.push("连接/快照");
  console.error(`\n硬错误：${e.message}`);
} finally {
  try { await restore(); } catch (e) { console.error(`还原失败：${e.message}`); }
  conn.sock?.close();
}

console.log(`\n通过 ${pass} · 失败 ${fail} · 跳过 ${skip} · 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (fails.length) console.log("失败项：\n  - " + fails.join("\n  - "));
process.exit(fail ? 1 : 0);
