// test/ui-regression.mjs
// 真实 Obsidian 界面回归：把散在 D:/tmp 的 tb_a/tb_b/tb_c 收敛成一份常驻脚本。
//
//   npm run test:ui                          全部
//   node test/ui-regression.mjs toolbar map  只跑名字含这些词的步骤
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
// 而非 path），界面微调也会连带改坏断言。等待统一走 waitFor 轮询，不再撒固定 setTimeout。

import fs from "node:fs";
import path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CDP = process.env.GS_CDP || "http://127.0.0.1:9333";
const VAULT = process.env.GS_VAULT || "D:/all codes projeck/ob库--个人记录";
const PLUGIN = "goalscape-obsidian";
const SCAPE_DIR_NAME = "Goalscapes";
const SCAPE_DIR = path.join(VAULT, SCAPE_DIR_NAME);
const SHOT_DIR = path.join(ROOT, "node_modules", ".goalscape-ui");
const TMP_NAME = "ZZ_GS_UI_REGRESSION";
const TMP_PATH = `${SCAPE_DIR_NAME}/${TMP_NAME}.goalscape.json`;
const TMP_CANVAS = `${SCAPE_DIR_NAME}/${TMP_NAME}.canvas`;
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
    await new Promise((r) => setTimeout(r, 150));
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
      for(const p of [${JSON.stringify(TMP_CANVAS)}, ${JSON.stringify(TMP_PATH)}]){
        const f=app.vault.getAbstractFileByPath(p); if(f) await app.vault.delete(f);
      }
      if(pl.store.path!==${JSON.stringify(start.path)}) await pl.switchGoalscape(${JSON.stringify(start.path)});
      await new Promise(r=>setTimeout(r,400));
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
    v.select(id); await new Promise(r=>setTimeout(r,300));
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
    await new Promise(r=>setTimeout(r,400));
    return {dimmed:document.querySelectorAll('svg.goalscape-radial-svg path[data-id].goalscape-dimmed').length,
      all:document.querySelectorAll('svg.goalscape-radial-svg path[data-id]').length,
      sheen:document.querySelectorAll('svg.goalscape-radial-svg .goalscape-sheen.goalscape-dimmed').length,
      dot:document.querySelector('.goalscape-filter-btn').classList.contains('is-active')};})()`);
  // 光源叠层也要一起变淡，否则未命中的格子上还留着一圈亮边把眼睛勾过去
  ok("无匹配标签 → 全图降饱和（含光源叠层）+ 漏斗亮圆点",
    dim.all > 0 && dim.dimmed === dim.all && dim.sheen === dim.all && dim.dot, JSON.stringify(dim));

  const away = await json(`(async()=>{
    document.querySelector('svg.goalscape-radial-svg').dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:500,clientY:400}));
    await new Promise(r=>setTimeout(r,300));
    return {closed:!document.querySelector('.goalscape-filter-popover').offsetParent,
      dot:document.querySelector('.goalscape-filter-btn').classList.contains('is-active'),
      dimmed:document.querySelectorAll('svg.goalscape-radial-svg path.goalscape-dimmed').length};})()`);
  ok("点浮层外只关面板、筛选条件仍生效", away.closed && away.dot && away.dimmed > 0, JSON.stringify(away));

  const toggle = await json(`(async()=>{
    const b=document.querySelector('.goalscape-filter-btn');
    b.dispatchEvent(new MouseEvent('click',{bubbles:true})); await new Promise(r=>setTimeout(r,250));
    const open=!!document.querySelector('.goalscape-filter-popover').offsetParent;
    b.dispatchEvent(new MouseEvent('click',{bubbles:true})); await new Promise(r=>setTimeout(r,250));
    return {open, closedAgain:!document.querySelector('.goalscape-filter-popover').offsetParent};})()`);
  ok("再点漏斗：先开后关（捕获阶段的点外面判定没抢关）", toggle.open && toggle.closedAgain, JSON.stringify(toggle));

  const cleared = await json(`(async()=>{
    document.querySelector('.goalscape-filter-btn').dispatchEvent(new MouseEvent('click',{bubbles:true}));
    await new Promise(r=>setTimeout(r,250));
    document.querySelector('.goalscape-filter-clear').dispatchEvent(new MouseEvent('click',{bubbles:true}));
    await new Promise(r=>setTimeout(r,400));
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
    await new Promise(x=>setTimeout(x,500));
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

step("canvas 段复用已有白板、不重导出", async () => {
  const seg = `.goalscape-view-seg[aria-label^="Canvas"]`;
  const doc = () => json(`JSON.parse(await app.vault.adapter.read(${JSON.stringify(TMP_CANVAS)}))`);
  /** 每次点击前都重新钉住当前图：用户本人可能正在应用里切图，不钉就会拿到别人的树 */
  const clickCanvas = async () => {
    await useTmpMap();
    await clickEl(seg);
    await waitFor(`app.workspace.getLeavesOfType('canvas').some(l=>l.view.file?.path===${JSON.stringify(TMP_CANVAS)})`, "白板标签页打开");
    await new Promise((r) => setTimeout(r, 700)); // 给 Obsidian 自己的落盘留出时间
  };
  const closeCanvas = () => json(`(async()=>{
    for(const l of app.workspace.getLeavesOfType('canvas'))
      if(l.view.file?.path===${JSON.stringify(TMP_CANVAS)}) await l.detach();
    return 1;})()`);

  await clickCanvas();
  const first = await doc();

  // 手工把一个节点挪走并改名：若第二次点 Canvas 是"原样打开"，这些值必须还在；
  // 若走了重导出（toCanvas 按放射布局重算坐标），坐标和文本都会被冲掉。
  const moved = { ...first.nodes[0], x: 9999, y: -8888, label: "ZZ-MARKER" };
  await json(`(async()=>{
    const f=app.vault.getAbstractFileByPath(${JSON.stringify(TMP_CANVAS)});
    const doc=${JSON.stringify({ ...first, nodes: first.nodes.map((n, i) => (i === 0 ? moved : n)) })};
    await app.vault.modify(f, JSON.stringify(doc)); return 1;})()`);
  await closeCanvas();

  await clickCanvas();
  const second = await doc();
  const kept = second.nodes?.[0];
  ok("第二次点 Canvas 原样打开（手工挪动/改名的节点没被重算）",
    kept?.label === "ZZ-MARKER" && kept?.x === 9999 && kept?.y === -8888,
    JSON.stringify(kept)?.slice(0, 120));
  ok("节点与连线数量不变",
    second.nodes?.length === first.nodes?.length && second.edges?.length === first.edges?.length,
    `${first.nodes?.length}n/${first.edges?.length}e → ${second.nodes?.length}n/${second.edges?.length}e`);
  const bytes = await json(`app.vault.adapter.read(${JSON.stringify(TMP_CANVAS)}).then(t=>t.length)`);
  info("白板文件被 Obsidian 自己的序列化器改写过（字节数变化属正常，节点数据未丢）", `${bytes} chars`);

  await closeCanvas();
  const state = await json(`({
    radialTabs:app.workspace.getLeavesOfType(${JSON.stringify(RADIAL)}).length,
    activeSeg:[...document.querySelectorAll('.goalscape-view-seg.is-active')].map(b=>b.getAttribute('aria-label')).join(','),
    canvasTabs:app.workspace.getLeavesOfType('canvas').filter(l=>l.view.file?.path===${JSON.stringify(TMP_CANVAS)}).length})`);
  ok("Canvas 段不改变本标签页视图、白板标签不重复堆叠",
    state.radialTabs === 1 && state.activeSeg === "Radial map" && state.canvasTabs === 0, JSON.stringify(state));
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
    await new Promise(r=>setTimeout(r,600));
    const v=pl.radialViews()[0];
    const shapes={}; for(const [id,s] of v.nodePositions) shapes[id]={rIn:Math.round(s.rInner),rOut:Math.round(s.rOuter),span:+(s.endAngle-s.startAngle).toFixed(4)};
    const bbox=document.querySelector('svg.goalscape-radial-svg').getBBox();
    return {shapes,bbox:{x:Math.round(bbox.x),y:Math.round(bbox.y),w:Math.round(bbox.width),h:Math.round(bbox.height)},
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
  // 根节点会画两行（标题 + 百分比），所以不能拿 label 数和 sector 数比大小，按内容判
  const narrow = tree.shapes["n-极窄也要有个名字的小目标"];
  const narrowArc = narrow.span * (narrow.rIn + narrow.rOut) / 2;
  ok("弧长不够的窄格不画字，但扇区仍在、<title> 全名也在（悬停可辨）",
    narrowArc < 26 && !tree.labels.some((t) => t.includes("极窄")) && !!narrow,
    `arc=${narrowArc.toFixed(1)}px labels含极窄=${tree.labels.some((t) => t.includes("极窄"))}`);
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
    await new Promise(r=>setTimeout(r,400));
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
    await new Promise(r=>setTimeout(r,400));

    const out={title:document.querySelector('.goalscape-panel-title').textContent,
      before:byTitle('Over').bandScale,
      activeAtStart:[...row().querySelectorAll('.goalscape-band-btn')].findIndex(b=>b.classList.contains('is-active'))};
    // 改厚度前先把每个扇区的内外径记下来：调一个块，只允许它自己和它的后代动，
    // 父块与别的分支必须原样（早先按"累计最厚链"归一 unit，改一处全图跟着变宽窄）
    const snap=()=>{const o={};for(const [id,s] of v.nodePositions)o[id]=[Math.round(s.rInner),Math.round(s.rOuter)];return o;};
    const shapesBefore=snap();
    btns(3).dispatchEvent(new MouseEvent('click',{bubbles:true})); await new Promise(r=>setTimeout(r,400));
    out.thick=byTitle('Over').bandScale;
    const shapesThick=snap();
    out.moved=Object.keys(shapesThick).filter((k)=>shapesThick[k].join()!==(shapesBefore[k]||[]).join()).sort();
    btns(2).dispatchEvent(new MouseEvent('click',{bubbles:true})); await new Promise(r=>setTimeout(r,400));
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

/** 读当前画布上每个扇区的 fill；调用方自己 return fills */
const FILLS = `const fills={};
    for(const p of document.querySelectorAll('svg.goalscape-radial-svg path[data-id]'))
      fills[p.getAttribute('data-id')]=p.getAttribute('fill');`;
const hueMap = (f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, Math.round(hsl(v).h)]));
const byLum = (f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, `${v}/${lum(v).toFixed(3)}`]));

step("color 分支统一色：色系只在二级、其余层级调明度", async () => {
  await useTmpMap();

  const painted = await json(`(async()=>{
    ${PL}.store.mutate(s=>{s.mainGoal=${JSON.stringify(toGoalNode(BRANCHES))};});
    await new Promise(r=>setTimeout(r,600));
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


  // 进度改画在外缘：map 里每个节点是"扇区 → 光源 → 进度条"三连，
  // 按 DOM 顺序把装饰层归给最近的 data-id 扇区，不用给它们再挂一个 id
  const rim = await json(`(()=>{
    const out={}; let cur=null;
    for(const p of document.querySelectorAll('.goalscape-map > path')){
      if(p.hasAttribute('data-id')){ cur=p.getAttribute('data-id'); out[cur]={}; continue; }
      if(!cur) continue;
      if(p.classList.contains('goalscape-rim')){
        const done=parseFloat(p.getAttribute('stroke-dasharray'));
        out[cur].ratio=p.getTotalLength()?done/p.getTotalLength():-1;
      }
    }
    return {rims:out,
      rimCount:document.querySelectorAll('.goalscape-map > path.goalscape-rim').length,
      sectors:document.querySelectorAll('.goalscape-map > path[data-id]').length,
      sheens:document.querySelectorAll('.goalscape-sheen').length,
      mapFilter:getComputedStyle(document.querySelector('.goalscape-map')).filter,
      // 全页 radialGradient 不止我们这一个（Obsidian 自带图标里有），必须锁定本视图 svg 内的那一个
      grad:(()=>{const g=document.querySelector('svg.goalscape-radial-svg radialGradient');
        if(!g) return null;
        return {id:g.id, units:g.getAttribute('gradientUnits'),
          cx:g.getAttribute('cx'), cy:g.getAttribute('cy'), r:g.getAttribute('r'),
          stops:[...g.children].map(s=>s.getAttribute('stop-opacity')),
          used:[...document.querySelectorAll('.goalscape-sheen')]
            .every(p=>p.getAttribute('fill')==='url(#'+g.id+')')};})()};})()`);
  const ratio = (id) => rim.rims[id] && rim.rims[id].ratio;
  ok("进度条画在扇区外缘：dash 占比即完成度（0/50/100 各归各）",
    Math.abs(ratio("n-B-zero")) < 0.01 && Math.abs(ratio("n-B-done") - 1) < 0.01
      && Math.abs(ratio("n-B-mid") - 0.5) < 0.02 && Math.abs(ratio("n-Blue") - 0.5) < 0.02,
    JSON.stringify({ zero: ratio("n-B-zero"), done: ratio("n-B-done"), mid: ratio("n-B-mid"), blue: ratio("n-Blue") }));
  // 光源是**每个块自己**的一束：gradientUnits 缺省即 objectBoundingBox，按各自外接框算
  ok("每个扇区一层自己的光源（objectBoundingBox）+ 一条进度条，没走到的地方不留轨道",
    rim.sectors === rim.sheens && rim.sectors === rim.rimCount && rim.grad && rim.grad.used
      && rim.grad.units === null && rim.grad.cx === "0.5" && rim.grad.stops.length === 3
      && /^goalscape-sheen-\d+$/.test(rim.grad.id),
    JSON.stringify({ sectors: rim.sectors, sheens: rim.sheens, rimCount: rim.rimCount, grad: rim.grad }));
  ok("整组一份柔和投影（投影打在组上，不是逐扇区）",
    /drop-shadow/.test(rim.mapFilter), rim.mapFilter);
  // 截图前清掉选中：强调色描边和权重手柄会把进度条本身糊住
  await ev(`${PL}.radialViews()[0].clearSelection()`);
  await new Promise((r) => setTimeout(r, 350));
  info(`进度条 + 光源 + 投影截图：${await shot("progress-rim")}`);

  const panelAt = (id) => json(`(async()=>{
    const v=${PL}.radialViews()[0]; v.select(${JSON.stringify(id)});
    await new Promise(r=>setTimeout(r,350));
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
    await new Promise(r=>setTimeout(r,350));
    // 点色盘第一格（取色器和 Auto 的 title 不是 hex），不写死 hex：色盘由 palette.ts 生成，会跟着基调变
    const sw=[...document.querySelectorAll('.goalscape-panel .goalscape-swatch')].find(s=>(s.title||'').startsWith('#'));
    const pickedHex=sw.title;
    sw.dispatchEvent(new MouseEvent('click',{bubbles:true}));
    await new Promise(r=>setTimeout(r,600));
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
    await new Promise(r=>setTimeout(r,350));
    const row=[...document.querySelectorAll('.goalscape-panel .setting-item')]
      .find(r=>r.querySelector('.setting-item-name')?.textContent.trim()==='Brightness');
    const el=row.querySelector('input[type=range]');
    el.value='-15';
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
    await new Promise(r=>setTimeout(r,600));
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
    await new Promise(r=>setTimeout(r,600));
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

step("themes 暗/亮两主题截图", async () => {
  await json(`(async()=>{
    const pl=${PL};
    if(pl.store.path!==${JSON.stringify(start.path)}) await pl.switchGoalscape(${JSON.stringify(start.path)});
    await new Promise(r=>setTimeout(r,400));
    app.workspace.revealLeaf(app.workspace.getLeavesOfType(${JSON.stringify(RADIAL)})[0]);
    await new Promise(r=>setTimeout(r,300));
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
