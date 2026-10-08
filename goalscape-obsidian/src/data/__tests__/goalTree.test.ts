// src/data/goalTree.ts（GoalTreeStore）的契约。
// 这里锁住的全是 PROGRESS.md 里付出过代价的真实回归：
// 启动早期建目录抛错导致整个插件 onload 失败、文件被截断成 0 字节的丢数据、
// 自己写盘又把自己读回来的抖动。

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { DEFAULT_GOALSCAPE_PATH, GoalTreeStore, createDefaultScape } from "../goalTree";
import { addGoal, renameGoal } from "../crud";
import { createGoalNode } from "../types";
import type { GoalScape } from "../types";
import { createEnvironment, flush, notices, settle } from "../../../test/helpers/fake-vault";

const PATH = DEFAULT_GOALSCAPE_PATH;

function json(mainGoal: unknown): string {
  return JSON.stringify({ version: 1, mainGoal });
}

function scapeJson(title: string): string {
  return json({ id: "root", title, importance: 100, tags: [], children: [] });
}

function reloadTimer(store: GoalTreeStore): number | null {
  return (store as unknown as { reloadTimer: number | null }).reloadTimer;
}

describe("load / 建档", () => {
  it("文件不存在时建目录、写默认图、登记 file 与监听", async () => {
    const { vault, store, registeredEvents } = createEnvironment();
    let notified = 0;
    store.subscribe(() => notified++);

    await store.load();

    assert.ok(vault.folders.has("Goalscapes"), "应建出 Goalscapes 目录");
    const written = JSON.parse(vault.contents.get(PATH) ?? "") as GoalScape;
    assert.equal(written.version, 1);
    assert.equal(written.mainGoal.title, "Main Goal");
    assert.equal(written.mainGoal.children.length, 3);
    assert.equal(store.file?.path, PATH, "落盘后要拿回 TFile 引用");
    assert.match(notices().join("\n"), /created/);
    assert.equal(registeredEvents.length, 2, "modify + delete 各一个");
    assert.equal(notified, 1, "只有自己写盘的那次 modify 不能又触发一轮 notify");
  });

  it("默认图结构：中心 + Health/Career/Relationships", async () => {
    const scape = createDefaultScape();
    assert.deepEqual(
      scape.mainGoal.children.map((c) => c.title),
      ["Health", "Career", "Relationships"]
    );
    assert.deepEqual(
      scape.mainGoal.children.map((c) => c.importance),
      [40, 35, 25]
    );
  });

  it("回归：启动早期索引未就绪、createFolder 抛 'Folder already exists.' 也不能打断 load", async () => {
    const { vault, store } = createEnvironment({ [PATH]: scapeJson("Manual") });
    vault.folders.add("Goalscapes");
    vault.staleIndex.add("Goalscapes");

    await store.load();

    assert.equal(store.scape.mainGoal.title, "Manual", "load() 没有 reject，数据照常读入");
  });

  it("外部手写的 JSON 缺字段时补齐，废弃的 responsible 被清掉", async () => {
    const { store } = createEnvironment({
      [PATH]: json({
        title: "Manual",
        responsible: ["old owner"],
        children: [{ title: "Kid", responsible: ["nobody"] }],
      }),
    });
    await store.load();

    const root = store.scape.mainGoal;
    assert.ok(root.id, "补 id");
    assert.equal(root.importance, 50, "缺省权重按 createGoalNode 约定补 50");
    assert.deepEqual(root.tags, []);
    const kid = root.children[0];
    assert.equal(kid.title, "Kid");
    assert.ok(kid.id && kid.id !== root.id, "子节点补的是新 id");
    assert.deepEqual(kid.children, []);
    assert.equal("responsible" in root, false, "已废弃字段读档即清理");
    assert.equal("responsible" in kid, false);
  });

  it("色相只属于二级节点：根与深层残留的旧 color 读档即清，brightness 收进 ±20", async () => {
    const { store } = createEnvironment({
      [PATH]: json({
        id: "root",
        title: "Manual",
        importance: 100,
        color: "#0000ff",
        brightness: 3,
        children: [
          {
            id: "b",
            title: "Branch",
            importance: 50,
            color: "#f87171",
            children: [{ id: "d", title: "Deep", importance: 50, color: "#00ff00", brightness: -90 }],
          },
        ],
      }),
    });
    await store.load();

    const root = store.scape.mainGoal;
    const branch = root.children[0];
    assert.equal("color" in root, false, "根不持有分支色相");
    assert.equal(branch.color, "#f87171", "二级节点的原值保留");
    assert.equal("color" in branch.children[0], false, "深层的旧色值清掉，免得留下图上不生效的死字段");
    assert.equal(root.brightness, 3);
    assert.equal(branch.children[0].brightness, -20, "越界值夹到边界");
  });

  it("拒绝解析 version 不为 1 的文件，保留内存副本", async (t) => {
    const { vault, store } = createEnvironment({ [PATH]: scapeJson("Good") });
    await store.load();
    assert.equal(store.scape.mainGoal.title, "Good");
    const logged = t.mock.method(console, "error", () => {});

    vault.externalEdit(PATH, JSON.stringify({ version: 2, mainGoal: { title: "Future" } }));
    await settle();

    assert.equal(store.scape.mainGoal.title, "Good");
    assert.equal(logged.mock.callCount(), 1, "解析失败要留日志");
    assert.match(notices().join("\n"), /failed to parse/);
  });
});

describe("落盘安全", () => {
  it("回归：写盘内容永远非空且可解析（不会把文件截断成 0 字节）", async () => {
    const { vault, store } = createEnvironment({ [PATH]: scapeJson("Good") });
    await store.load();

    store.mutate((s) => addGoal(s, s.mainGoal.id, "child", "Kid"));
    await flush();
    store.mutate((s) => renameGoal(s, "root", "Renamed"));
    await flush();

    assert.ok(vault.writeLog.length >= 2);
    for (const content of vault.writeLog) {
      assert.ok(content.length > 0, "绝不写空内容");
      assert.doesNotThrow(() => JSON.parse(content));
    }
    const after = JSON.parse(vault.contents.get(PATH) ?? "") as GoalScape;
    assert.equal(after.mainGoal.children.length, 1);
    assert.equal(after.mainGoal.title, "Renamed");
  });

  it("回归：文件被外部截断成空后，内存副本保留且下次变更能自愈", async (t) => {
    const { vault, store } = createEnvironment({ [PATH]: scapeJson("Good") });
    await store.load();
    const snapshot = JSON.stringify(store.scape);
    const logged = t.mock.method(console, "error", () => {});

    vault.externalEdit(PATH, "");
    await settle();

    assert.equal(JSON.stringify(store.scape), snapshot, "空文件不能被读进来覆盖内存");
    assert.equal(vault.writeLog.length, 0, "解析失败时不做任何写回");
    assert.equal(logged.mock.callCount(), 1);

    store.mutate((s) => renameGoal(s, "root", "Recovered"));
    await flush();
    assert.equal((vault.contents.get(PATH) ?? "").length > 0, true, "变更后重新写回完整内容");
  });

  it("还没读到数据时 save/mutate 都不写盘、不执行回调", async () => {
    const { vault, store } = createEnvironment();
    await store.save();
    store.mutate(() => assert.fail("scape 未加载时不该执行变更"));
    assert.equal(vault.writeLog.length, 0);
    assert.equal(vault.contents.size, 0);
  });

  it("mutate 之后进度已汇总再落盘", async () => {
    const { vault, store } = createEnvironment({ [PATH]: scapeJson("Good") });
    await store.load();

    store.mutate((s) => {
      const leaf = createGoalNode({ title: "Run 5k", importance: 100, progress: 80 });
      s.mainGoal.children.push(leaf);
    });
    await flush();

    assert.equal(store.scape.mainGoal.progress, 80, "汇总发生在落盘之前");
    const written = JSON.parse(vault.contents.get(PATH) ?? "") as GoalScape;
    assert.equal(written.mainGoal.progress, 80);
  });

  it("落盘前同样按层级清理色相：粘贴到深层的 color 进不了文件", async () => {
    const { vault, store } = createEnvironment({
      [PATH]: json({
        id: "root",
        title: "R",
        importance: 100,
        children: [{ id: "b", title: "B", importance: 50, color: "#38bdf8", children: [] }],
      }),
    });
    await store.load();

    store.mutate((s) => {
      s.mainGoal.children[0].children.push(createGoalNode({ id: "d", title: "D", color: "#00ff00" }));
    });
    await flush();

    const written = JSON.parse(vault.contents.get(PATH) ?? "") as GoalScape;
    assert.equal(written.mainGoal.children[0].color, "#38bdf8", "二级节点的色相照常落盘");
    assert.equal("color" in written.mainGoal.children[0].children[0], false, "深层的死字段不写回磁盘");
  });
});

describe("外部修改与文件切换", () => {
  it("外部编辑去抖后自动读回并通知订阅者", async () => {
    const { vault, store } = createEnvironment({ [PATH]: scapeJson("Good") });
    let notified = 0;
    store.subscribe(() => notified++);
    await store.load();
    assert.equal(notified, 1);

    vault.externalEdit(PATH, scapeJson("Edited outside"));
    await settle();

    assert.equal(store.scape.mainGoal.title, "Edited outside");
    assert.equal(notified, 2);
  });

  it("自己写盘触发的 modify 不会把自己再读回来", async () => {
    const { store } = createEnvironment({ [PATH]: scapeJson("Good") });
    let notified = 0;
    store.subscribe(() => notified++);
    await store.load();

    store.mutate((s) => addGoal(s, s.mainGoal.id, "child", "Kid"));
    await flush();
    await settle();

    assert.equal(notified, 2, "load 一次 + mutate 一次，写盘的 modify 被静默");
    assert.equal(reloadTimer(store), null, "不该挂上去抖计时器");
  });

  it("取消订阅后不再收到通知", async () => {
    const { store } = createEnvironment({ [PATH]: scapeJson("Good") });
    let notified = 0;
    const unsubscribe = store.subscribe(() => notified++);
    await store.load();
    assert.equal(notified, 1);

    unsubscribe();
    store.mutate((s) => renameGoal(s, "root", "X"));
    assert.equal(notified, 1);
  });

  it("switchTo：换路径、读新文件、清掉旧文件挂起的重载计时器", async () => {
    const other = "Goalscapes/other.goalscape.json";
    const { vault, store } = createEnvironment({ [PATH]: scapeJson("Old"), [other]: scapeJson("Other") });
    await store.load();

    vault.externalEdit(PATH, scapeJson("PENDING"));
    assert.notEqual(reloadTimer(store), null, "先确认 reload 已排队");

    await store.switchTo(other);

    assert.equal(reloadTimer(store), null, "switchTo 必须清掉旧路径的挂起 reload");
    assert.equal(store.path, other);
    await settle();
    assert.equal(store.scape.mainGoal.title, "Other", "旧的排队 reload 不能再来覆盖");
    assert.equal(store.file?.path, other);
  });

  it("switchTo 同一个文件是空操作", async () => {
    const { store } = createEnvironment({ [PATH]: scapeJson("Old") });
    await store.load();
    let notified = 0;
    store.subscribe(() => notified++);

    await store.switchTo(PATH);

    assert.equal(notified, 0);
  });

  it("反复切换文件也只注册一次外部监听", async () => {
    const other = "Goalscapes/other.goalscape.json";
    const { store, registeredEvents } = createEnvironment({ [PATH]: scapeJson("A"), [other]: scapeJson("B") });
    await store.load();
    await store.switchTo(other);
    await store.switchTo(PATH);

    assert.equal(registeredEvents.length, 2, "modify + delete，不随切换叠加");
  });

  it("文件被删除时清空 file 引用", async () => {
    const { vault, store } = createEnvironment({ [PATH]: scapeJson("Good") });
    await store.load();
    assert.ok(store.file);

    vault.remove(PATH);

    assert.equal(store.file, null);
  });
});
