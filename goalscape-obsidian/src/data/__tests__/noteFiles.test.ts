// src/data/noteFiles.ts（NoteStore）的契约：块 ↔ .md 文件这层适配里所有不开界面就能判的行为。
// 用户拍板"md 文件是唯一真相"之后，这里锁的是最要命的几条：
// 绝不替用户建文件、同名块不互相覆盖、frontmatter 不渗进摘要、
// 在 Obsidian 里改名/删掉之后树里那条路径要么自愈要么干净地变成"没有笔记"。

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import type { TFile } from "obsidian";
import { DEFAULT_GOALSCAPE_PATH } from "../goalTree";
import { GS_ID_KEY, NoteStore } from "../noteFiles";
import { findNode } from "../types";
import type { GoalNode, GoalScape } from "../types";
import { createEnvironment, flush, settle } from "../../../test/helpers/fake-vault";

const MAP = DEFAULT_GOALSCAPE_PATH; // Goalscapes/life.goalscape.json
const DIR = "Goalscapes/life.notes";

function rawNode(o: Record<string, unknown>): Record<string, unknown> {
  return { importance: 50, tags: [], children: [], ...o };
}

function json(children: Array<Record<string, unknown>>): string {
  const scape: GoalScape = {
    version: 1,
    mainGoal: { id: "root", title: "Main", importance: 100, tags: [], children } as unknown as GoalNode,
  };
  return JSON.stringify(scape);
}

async function setup(
  children: Array<Record<string, unknown>> = [],
  files: Record<string, string> = {}
) {
  const env = createEnvironment({ [MAP]: json(children), ...files });
  await env.store.load();
  return { ...env, notes: new NoteStore(env.plugin, env.store) };
}

function node(store: { scape: GoalScape | null }, id: string): GoalNode {
  return findNode(store.scape!.mainGoal, id)!.node;
}

/** 数一数 store 通知了几次：watch 的"该重画的重画、不该重画的别吵"全靠它 */
function countNotify(store: { subscribe(fn: () => void): () => void }): () => number {
  let n = 0;
  store.subscribe(() => (n += 1));
  return () => n;
}

describe("folderFor：笔记目录跟图文件同级", () => {
  it("图名去掉 .goalscape.json 再加 .notes，删图的时候它就在旁边", async () => {
    const { notes } = await setup();
    assert.equal(notes.folderFor(MAP), DIR);
    assert.equal(notes.folderFor("Goalscapes/2026/work.goalscape.json"), "Goalscapes/2026/work.notes");
    assert.equal(notes.folderFor("solo.goalscape.json"), "solo.notes");
  });
});

describe("createFor：建文件", () => {
  // createFor 只看 id 与 title，这里直接造裸节点，省掉建树
  const block = (id: string, title: string): GoalNode =>
    ({ id, title, importance: 50, tags: [], children: [] }) as GoalNode;

  it("建出目录、写 frontmatter 记 gsId，正文留空给用户写", async () => {
    const { vault, notes } = await setup([{ id: "h1", title: "Run" }]);
    const path = await notes.createFor(block("h1", "Run"));
    assert.equal(path, `${DIR}/Run.md`);
    assert.ok(vault.folders.has(DIR), "目录得先建出来，否则 create 会失败");
    assert.equal(vault.contents.get(path), `---\n${GS_ID_KEY}: h1\n---\n\n`);
  });

  it("文件名里的非法字符换成空格，超长截断，全非法时退到 note", async () => {
    const { notes } = await setup();
    assert.equal(await notes.createFor(block("a", "Run/5k: *test*?")), `${DIR}/Run 5k test.md`);
    assert.equal(await notes.createFor(block("b", "x".repeat(90))), `${DIR}/${"x".repeat(60)}.md`);
    assert.equal(await notes.createFor(block("c", "??? ")), `${DIR}/note.md`);
    assert.equal(await notes.createFor(block("d", "Plan.")), `${DIR}/Plan.md`);
  });

  it("两个块同名也不会指到同一个文件上：第二个自动加序号", async () => {
    const { notes } = await setup([{ id: "a", title: "Run" }, { id: "b", title: "Run" }]);
    assert.equal(await notes.createFor(block("a", "Run")), `${DIR}/Run.md`);
    assert.equal(await notes.createFor(block("b", "Run")), `${DIR}/Run 2.md`);
  });

  it("不改树：建文件和记路径必须一起落盘，由调用方走 mutate", async () => {
    const { store, notes } = await setup([{ id: "a", title: "Run" }]);
    await notes.createFor(node(store, "a"));
    assert.equal(node(store, "a").note, undefined, "createFor 自己不许动树");
  });

  it("vault 里已经有同名文件时不覆盖用户的东西", async () => {
    const { vault, notes } = await setup(
      [{ id: "a", title: "Run" }],
      { [`${DIR}/Run.md`]: "用户自己写的" }
    );
    assert.equal(await notes.createFor(block("a", "Run")), `${DIR}/Run 2.md`);
    assert.equal(vault.contents.get(`${DIR}/Run.md`), "用户自己写的");
  });
});

describe("红线：绝不替用户建笔记文件", () => {
  it("没写过笔记的块，syncMap 之后 vault 里一个 .md 都不多", async () => {
    const { vault, notes } = await setup([
      { id: "a", title: "Run" },
      { id: "b", title: "Ship" },
      { id: "c", title: "Read" },
    ]);
    await notes.syncMap();
    const mds = vault.getMarkdownFiles().filter((f) => f.path.startsWith(`${DIR}/`));
    assert.deepEqual(mds, []);
    assert.equal(notes.notes.size, 0);
  });
});

describe("migrate：旧版存在 JSON 里的正文搬进 .md", () => {
  it("文件内容是 frontmatter + 原文，树里 notes 删掉、note 记路径，JSON 跟着落盘", async () => {
    const { vault, store, notes } = await setup([
      { id: "a", title: "Run", notes: "本周 5 公里，见 [[跑步日志]]" },
    ]);
    const n = await notes.syncMap();
    assert.equal(n, 1);
    assert.equal(vault.contents.get(`${DIR}/Run.md`), `---\n${GS_ID_KEY}: a\n---\n\n本周 5 公里，见 [[跑步日志]]\n`);
    assert.equal(node(store, "a").note, `${DIR}/Run.md`);
    assert.equal(node(store, "a").notes, undefined);
    await flush();
    assert.ok(!(vault.contents.get(MAP) ?? "").includes('"notes"'), "JSON 里不该再留正文");
  });

  it("空白正文只删字段、不建文件，也不计数", async () => {
    const { vault, store, notes } = await setup([
      { id: "a", title: "Run", notes: "   \n  " },
    ]);
    assert.equal(await notes.syncMap(), 0);
    assert.equal(vault.getMarkdownFiles().length, 0);
    assert.equal(node(store, "a").notes, undefined);
    assert.equal(node(store, "a").note, undefined);
  });

  it("两个块同名时各写各的文件，不会一个盖掉另一个", async () => {
    const { vault, notes } = await setup([
      { id: "a", title: "Run", notes: "甲" },
      { id: "b", title: "Run", notes: "乙" },
    ]);
    assert.equal(await notes.syncMap(), 2);
    assert.equal(vault.contents.get(`${DIR}/Run.md`), `---\n${GS_ID_KEY}: a\n---\n\n甲\n`);
    assert.equal(vault.contents.get(`${DIR}/Run 2.md`), `---\n${GS_ID_KEY}: b\n---\n\n乙\n`);
  });
});

describe("rebuild：把文件压成纯数据 NoteIndex", () => {
  it("text 剥掉 frontmatter（不剥的话 gsId 会变成摘要第一行），refs 只收解析得到的非嵌入目标", async () => {
    const body = ["今天跑 5 公里，见 [[跑步日志]]", "![[附图]]", "[[查无此人]]"].join("\n");
    const { notes } = await setup(
      [{ id: "a", title: "Run", note: `${DIR}/Run.md` }],
      {
        [`${DIR}/Run.md`]: `---\n${GS_ID_KEY}: a\n---\n\n${body}`,
        "跑步日志.md": "日志",
      }
    );
    await notes.syncMap();
    const info = notes.get("a")!;
    assert.equal(info.text.split("\n")[0], "今天跑 5 公里，见 [[跑步日志]]");
    assert.ok(!info.text.includes(GS_ID_KEY));
    assert.deepEqual(
      info.refs,
      [{ path: "跑步日志.md", anchor: "", goalId: null }],
      "嵌入不算关系，指不到的幽灵链接不进图，不属于任何块的笔记 goalId 为 null"
    );
  });

  it("锚点原样留着，指向别的块的笔记就认得出那个块", async () => {
    const { notes } = await setup(
      [
        { id: "a", title: "Run", note: `${DIR}/Run.md` },
        { id: "b", title: "Sleep", note: `${DIR}/Sleep.md` },
      ],
      {
        [`${DIR}/Run.md`]: `---\n${GS_ID_KEY}: a\n---\n\n见 [[Sleep#^计划]] 与 [[Sleep#睡眠]]`,
        [`${DIR}/Sleep.md`]: `---\n${GS_ID_KEY}: b\n---\n\n睡够 8 小时`,
      }
    );
    await notes.syncMap();
    assert.deepEqual(notes.get("a")?.refs, [
      { path: `${DIR}/Sleep.md`, anchor: "#^计划", goalId: "b" },
      { path: `${DIR}/Sleep.md`, anchor: "#睡眠", goalId: "b" },
    ]);
    assert.deepEqual(notes.get("b")?.refs, [], "没写链接就是没关系，不靠猜");
  });

  it("笔记链自己的另一节不算块间关系（自链会让弦线画成一个自环）", async () => {
    const { notes } = await setup([{ id: "a", title: "Run", note: `${DIR}/Run.md` }], {
      [`${DIR}/Run.md`]: `---\n${GS_ID_KEY}: a\n---\n\n见 [[Run#计划]]`,
    });
    await notes.syncMap();
    assert.deepEqual(notes.get("a")?.refs, []);
  });

  it("文件被用户删掉＝这块没有笔记，不追着重建", async () => {
    const { vault, store, notes } = await setup(
      [{ id: "a", title: "Run", note: `${DIR}/Run.md` }],
      { [`${DIR}/Run.md`]: `---\n${GS_ID_KEY}: a\n---\n\n正文` }
    );
    await notes.syncMap();
    assert.equal(notes.notes.size, 1);

    vault.remove(`${DIR}/Run.md`);
    await notes.rebuild();
    assert.equal(notes.get("a"), undefined);
    assert.equal(vault.getMarkdownFiles().length, 0, "删掉的笔记不许被插件写回来");
    assert.equal(node(store, "a").note, `${DIR}/Run.md`, "路径留着：用户可能只是把它挪走了");
  });

  it("在 Obsidian 里改名/挪走：按 frontmatter 的 gsId 全库找回，并把新路径写回树", async () => {
    const { vault, store, notes } = await setup(
      [{ id: "a", title: "Run", note: `${DIR}/Run.md` }],
      { [`${DIR}/Run.md`]: `---\n${GS_ID_KEY}: a\n---\n\n正文` }
    );
    await notes.syncMap();

    await vault.rename(vault.files.get(`${DIR}/Run.md`)!, "跑步/2026 Run.md");
    await notes.rebuild();
    await flush();

    assert.equal(notes.get("a")?.path, "跑步/2026 Run.md");
    assert.equal(node(store, "a").note, "跑步/2026 Run.md", "树里那条路径要自愈，否则下次启动又找一遍");
    assert.ok((vault.contents.get(MAP) ?? "").includes("2026 Run.md"), "新路径要落盘");
  });
});

describe("watch：只有自己的笔记被改才重画", () => {
  it("索引内文件被外部编辑 → 去抖后索引更新并通知视图", async () => {
    const { vault, store, notes } = await setup(
      [{ id: "a", title: "Run", note: `${DIR}/Run.md` }],
      { [`${DIR}/Run.md`]: `---\n${GS_ID_KEY}: a\n---\n\n旧正文` }
    );
    await notes.syncMap();
    notes.watch();
    const notified = countNotify(store);

    vault.externalEdit(`${DIR}/Run.md`, `---\n${GS_ID_KEY}: a\n---\n\n新正文`);
    assert.equal(notified(), 0, "去抖窗口内不该已经重画");
    await settle(700);
    assert.equal(notes.get("a")?.text, "新正文");
    assert.equal(notified(), 1);
  });

  it("用户在别的笔记里打字不该让放射图重画一遍", async () => {
    const { vault, store, notes } = await setup(
      [{ id: "a", title: "Run", note: `${DIR}/Run.md` }],
      {
        [`${DIR}/Run.md`]: `---\n${GS_ID_KEY}: a\n---\n\n正文`,
        "日记/2026-10-09.md": "无关",
      }
    );
    await notes.syncMap();
    notes.watch();
    const notified = countNotify(store);

    vault.externalEdit("日记/2026-10-09.md", "无关 + 一句");
    await settle(700);
    assert.equal(notified(), 0);
  });

  it("笔记目录里新建的文件（还没记进树）也算自己的事", async () => {
    const { vault, store, notes } = await setup([], {});
    await notes.syncMap();
    notes.watch();
    const notified = countNotify(store);

    await vault.create(`${DIR}/手写的.md`, "随手记");
    await settle(700);
    assert.equal(notified(), 1);
  });

  it("刚写出来的文件缓存还没解析完 → metadataCache changed 之后补一轮，链接不会永远缺", async () => {
    const { vault, notes } = await setup(
      [{ id: "a", title: "Run", note: `${DIR}/Run.md` }],
      { [`${DIR}/Run.md`]: `---\n${GS_ID_KEY}: a\n---\n\n见 [[跑步日志]]`, "跑步日志.md": "日志" }
    );
    vault.coldCache.add(`${DIR}/Run.md`);
    notes.watch();
    await notes.syncMap();
    assert.deepEqual(notes.get("a")?.refs, [], "冷缓存下这一轮确实读不到链接");

    vault.coldCache.delete(`${DIR}/Run.md`);
    vault.emitCacheChanged(`${DIR}/Run.md`);
    await settle(700);
    assert.deepEqual(
      notes.get("a")?.refs.map((r) => r.path),
      ["跑步日志.md"],
      "解析完必须自己追上，不能等用户再动一下"
    );
  });

  it("watch() 重复调用不重复注册监听", async () => {
    const { notes, registeredEvents } = await setup();
    const before = registeredEvents.length; // store.load() 自己那两条不算
    notes.watch();
    const after = registeredEvents.length;
    notes.watch();
    assert.equal(registeredEvents.length, after);
    assert.equal(after - before, 5, "vault 的 modify/create/delete/rename 各一条 + metadataCache changed");
  });
});

describe("ownerOf：这篇笔记是谁的笔记（笔记→块那条命令的唯一依据）", () => {
  // 运行时 "obsidian" 就是 test/mocks 那份，同一个 TFile 类；类型对不上只是编译期的事
  const file = (vault: { files: Map<string, unknown> }, path: string): TFile =>
    vault.files.get(path) as unknown as TFile;

  it("当前图的索引里路径对得上就认，不读正文", async () => {
    const { vault, notes } = await setup([{ id: "a", title: "Run", note: `${DIR}/Run.md` }], {
      [`${DIR}/Run.md`]: `---\n${GS_ID_KEY}: a\n---\n\n正文`,
    });
    await notes.syncMap();
    assert.deepEqual(notes.ownerOf(file(vault, `${DIR}/Run.md`)), { scapePath: MAP, goalId: "a" });
  });

  it("用户手写进笔记目录、树里没记路径的：按 frontmatter 的 gsId 认回当前这张图", async () => {
    const { vault, notes } = await setup([{ id: "a", title: "Run" }], {
      [`${DIR}/手写的.md`]: `---\n${GS_ID_KEY}: a\n---\n\n自己起的文件名`,
    });
    await notes.syncMap();
    assert.deepEqual(notes.ownerOf(file(vault, `${DIR}/手写的.md`)), { scapePath: MAP, goalId: "a" });
  });

  it("开着的是别的图的笔记：目录名反推出图路径，交给命令去切图", async () => {
    const { vault, notes } = await setup([{ id: "a", title: "Run" }], {
      "Goalscapes/2026/work.notes/计划.md": `---\n${GS_ID_KEY}: w7\n---\n\n正文`,
    });
    await notes.syncMap();
    assert.deepEqual(notes.ownerOf(file(vault, "Goalscapes/2026/work.notes/计划.md")), {
      scapePath: "Goalscapes/2026/work.goalscape.json",
      goalId: "w7",
    });
  });

  it("普通笔记一律 null：认不出归属就不制造跳不过去的入口", async () => {
    const { vault, notes } = await setup([{ id: "a", title: "Run" }], {
      "日记/2026-10-09.md": "今天没跑步",
      // gsId 指向的块早没了：留着旧 frontmatter 的笔记不该把命令勾起来
      "散落的.md": `---\n${GS_ID_KEY}: ghost\n---\n\n正文`,
    });
    await notes.syncMap();
    assert.equal(notes.ownerOf(file(vault, "日记/2026-10-09.md")), null);
    assert.equal(notes.ownerOf(file(vault, "散落的.md")), null);
  });
});

