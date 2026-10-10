// 树 → 白板的单向镜像契约。这里盯的是**丢东西**：
// 用户摆的位置、他自己的便签和他画的连线不能被冲掉；树里删掉的目标不能留鬼卡；
// 新卡不能压到已有卡；同一棵树导两次结果必须一模一样（"再生成一次布局就乱了"是不合格的）。
// 反向（白板 → 数据）实现过、删掉了，别再往回加，理由写在 canvasSync.ts 末尾。

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { createGoalNode } from "../../data/types";
import type { GoalNode, GoalScape } from "../../data/types";
import {
  toCanvas,
  refreshCanvas,
  trustedSnapshot,
  parseCanvasJson,
  canvasToJson,
  generatedEdgeId,
  linkEdgeId,
  fileEdgeId,
  fileNodeId,
} from "../canvasSync";
import type { CanvasNode, JsonCanvas } from "../canvasSync";
import type { NoteIndex } from "../../data/types";

function makeScape(): GoalScape {
  return {
    version: 1,
    mainGoal: createGoalNode({
      id: "root",
      title: "Main",
      importance: 100,
      children: [
        createGoalNode({ id: "health", title: "Health", importance: 60, children: [
          createGoalNode({ id: "h1", title: "Run", importance: 50 }),
          createGoalNode({ id: "h2", title: "Sleep", importance: 50 }),
        ] }),
        createGoalNode({ id: "career", title: "Career", importance: 40, children: [
          createGoalNode({ id: "c1", title: "Ship", importance: 100 }),
        ] }),
      ],
    }),
  };
}

const card = (id: string, gsId: string | undefined, extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id,
  type: "text",
  x: 0,
  y: 0,
  width: 220,
  height: 100,
  text: `**${id}**`,
  ...(gsId ? { gsId } : {}),
  ...extra,
});

/** 与 canvasSync 里判重叠同口径：24px 呼吸位 */
function overlaps(a: CanvasNode, b: CanvasNode): boolean {
  return (
    Math.abs(a.x - b.x) < (a.width + b.width) / 2 + 24 &&
    Math.abs(a.y - b.y) < (a.height + b.height) / 2 + 24
  );
}

function byId(c: JsonCanvas, id: string): CanvasNode {
  const n = c.nodes.find((x) => x.id === id);
  assert.ok(n, `卡片 ${id} 不在结果里`);
  return n;
}

function findGoal(node: GoalNode, id: string): GoalNode | null {
  if (node.id === id) return node;
  for (const c of node.children) {
    const hit = findGoal(c, id);
    if (hit) return hit;
  }
  return null;
}

describe("导出：机器字段、连线与坐标语义", () => {
  it("每张卡片带 gsId，父子连线用可识别的生成 id", () => {
    const c = toCanvas(makeScape());
    assert.deepEqual(c.nodes.map((n) => n.gsId), ["root", "health", "h1", "h2", "career", "c1"]);
    assert.deepEqual(c.edges.map((e) => e.id), ["health", "h1", "h2", "career", "c1"].map(generatedEdgeId));
    assert.deepEqual(c.edges.map((e) => `${e.fromNode}>${e.toNode}`), [
      "root>health", "health>h1", "health>h2", "root>career", "career>c1",
    ]);
  });

  it("x/y 是卡片中心（JSON Canvas 的语义），中心盘落在原点", () => {
    const root = byId(toCanvas(makeScape()), "root");
    // 根节点是 cos(mid)*0，算出来是 -0；=== 与 JSON.stringify 都把它当 0，deepEqual 却当成另一个值
    assert.ok(root.x === 0 && root.y === 0, "多减半个卡片尺寸就是把整张图往左上偏一格的由来");
  });
});

describe("镜像：用户摆的东西不能被冲掉", () => {
  it("沿用旧文件的 x/y/width/height，其余字段按数据重写", () => {
    const fresh = toCanvas(makeScape());
    const existing: JsonCanvas = {
      nodes: fresh.nodes.map((n) => ({ ...n, x: n.x + 5000, y: n.y - 400, width: 300 })),
      edges: [],
    };
    const merged = refreshCanvas(makeScape(), existing);
    const h = byId(merged, "health");
    assert.equal(h.x, byId(fresh, "health").x + 5000);
    assert.equal(h.width, 300, "尺寸也是用户调过的");
    assert.match(h.text ?? "", /Health/, "文字仍由数据派生");
  });

  it("便签和它自己牵的线原样保留", () => {
    const fresh = toCanvas(makeScape());
    const merged = refreshCanvas(makeScape(), {
      nodes: [card("sticky-1", undefined, { text: "随手记" }), ...fresh.nodes],
      edges: [{ id: "u-1", fromNode: "sticky-1", toNode: "root" }],
    });
    assert.ok(merged.nodes.some((n) => n.id === "sticky-1"), "便签不能被删");
    assert.ok(merged.edges.some((e) => e.id === "u-1"), "便签牵到树上那条线不能被删");
  });

  it("白板里改箭头不改结构：同 id 的生成边一律以树为准", () => {
    const fresh = toCanvas(makeScape());
    fresh.edges.find((e) => e.id === generatedEdgeId("h1"))!.fromNode = "career";
    const merged = refreshCanvas(makeScape(), fresh);
    assert.equal(
      merged.edges.find((e) => e.id === generatedEdgeId("h1"))!.fromNode,
      "health",
      "结构只有树一个主人；要保双向改动，导出就必然吃掉没同步的改动"
    );
  });

  it("改端点不算改结构：用户在 Obsidian 里拖过的 side 与箭头要接着留住", () => {
    const existing = toCanvas(makeScape());
    for (const e of existing.edges) {
      e.fromSide = "left";
      e.toEnd = "arrow";
    }
    const merged = refreshCanvas(makeScape(), existing);
    const e = merged.edges.find((x) => x.id === generatedEdgeId("h1"))!;
    assert.equal(e.fromSide, "left");
    assert.equal(e.toEnd, "arrow");
    assert.equal(e.fromNode, "health", "连线的两端由树说了算，只有端点样式归用户");
  });

  it("没有旧文件时结果就是数据本身", () => {
    const fresh = toCanvas(makeScape());
    assert.deepEqual(refreshCanvas(makeScape(), null), fresh);
  });

  it("同一棵树导两次一模一样（再生成不会把布局挪动）", () => {
    const once = refreshCanvas(makeScape(), toCanvas(makeScape()));
    const twice = refreshCanvas(makeScape(), once);
    assert.equal(canvasToJson(twice), canvasToJson(once));
  });

  it("旧白板（没有 gsId，节点 id 就是目标 id）照样认得出卡片", () => {
    const legacy = toCanvas(makeScape());
    for (const n of legacy.nodes) delete n.gsId;
    const existing: JsonCanvas = { nodes: legacy.nodes.map((n) => ({ ...n, x: n.x + 800 })), edges: [] };
    const merged = refreshCanvas(makeScape(), existing);
    assert.equal(byId(merged, "health").x, byId(existing, "health").x, "旧白板的位置也要留住");
    assert.equal(merged.nodes.filter((n) => n.id === "health").length, 1, "不能既当镜子又当便签画两遍");
  });
});

describe("镜像：树变了之后白板上不留脏东西", () => {
  it("树里删掉的目标，它的卡片跟着消失；没 gsId 的卡片不能误删", () => {
    const scape = makeScape();
    const fresh = toCanvas(scape);
    const existing: JsonCanvas = {
      nodes: [
        ...fresh.nodes.filter((n) => n.id !== "h1"),
        card("gone", "h1"),
        card("mine", undefined, { text: "自己加的" }),
      ],
      edges: [
        ...fresh.edges.filter((e) => e.toNode !== "h1"),
        { id: generatedEdgeId("h1"), fromNode: "health", toNode: "gone" },
      ],
    };
    const merged = refreshCanvas(scape, existing);
    assert.ok(!merged.nodes.some((n) => n.id === "gone"), "鬼卡要删");
    assert.ok(merged.nodes.some((n) => n.id === "mine"), "用户自己的卡片不能被当成鬼卡");
    assert.ok(!merged.edges.some((e) => e.toNode === "gone" || e.fromNode === "gone"), "指向鬼卡的线要一起删");
  });

  it("两张卡声称代表同一个目标：第一张当镜子，多出来的降级成便签", () => {
    const scape = makeScape();
    const mirrored = byId(toCanvas(scape), "health");
    const copy = card("health-copy", "health", { x: mirrored.x + 4000, y: mirrored.y + 4000 });
    const merged = refreshCanvas(scape, { nodes: [{ ...mirrored, x: -7777, y: 111 }, copy], edges: [] });
    assert.deepEqual([byId(merged, "health").x, byId(merged, "health").y], [-7777, 111], "镜子用第一张的位置");
    assert.equal(byId(merged, "health-copy").gsId, undefined, "副本要抹掉认领，否则下一轮它又来抢");
    assert.equal(merged.nodes.filter((n) => n.gsId === "health").length, 1, "同一目标只能有一张镜子卡");
  });

  it("新目标加在已有卡片堆里：不压任何卡片，也不飞到远处", () => {
    const scape = makeScape();
    findGoal(scape.mainGoal, "c1")!.children.push(createGoalNode({ id: "n1", title: "New", importance: 100 }));
    const algo = byId(toCanvas(scape), "n1");
    // 用户摆的东西：一张便签正好压在 n1 该待的位置上
    const existing: JsonCanvas = {
      nodes: [...toCanvas(makeScape()).nodes, card("blocker", undefined, { x: algo.x, y: algo.y, text: "我摆在这" })],
      edges: [],
    };

    const merged = refreshCanvas(scape, existing);
    const placed = byId(merged, "n1");
    for (const other of merged.nodes) {
      if (other.id !== "n1") assert.ok(!overlaps(placed, other), `新卡片压到了 ${other.id}`);
    }
    assert.ok(Math.hypot(placed.x - algo.x, placed.y - algo.y) <= 800, "让开就该在附近，不该跳去画布另一头");
    assert.ok(merged.nodes.some((n) => n.id === "blocker"), "挡住它的便签不能被删");
  });
});

describe("镜像：笔记派生出的链接边与文件卡片", () => {
  /**
   * 笔记索引的最小构造：镜像只吃 text 与 refs，两者都是 NoteStore 读文件后填进来的。
   * refs 写成 `路径#锚点` 的字符串，owner 说明哪条路径是某个块的笔记（→ goalId）。
   */
  const notes = (m: Record<string, { text?: string; refs?: string[] }>, owner: Record<string, string> = {}): NoteIndex =>
    new Map(
      Object.entries(m).map(([id, v]) => [
        id,
        {
          path: `Goalscapes/x.notes/${id}.md`,
          text: v.text ?? "",
          refs: (v.refs ?? []).map((raw) => {
            const hash = raw.indexOf("#");
            const path = hash < 0 ? raw : raw.slice(0, hash);
            return { path, anchor: hash < 0 ? "" : raw.slice(hash), goalId: owner[path] ?? null };
          }),
        },
      ])
    );

  /** 用户自己从目录栏拖进白板的文件卡：没有 gsFile，不属于树，动不得 */
  const userFile = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({
    id,
    type: "file",
    file: "x.md",
    x: 0,
    y: 0,
    width: 260,
    height: 120,
    ...extra,
  });

  it("卡片正文只追加一行笔记摘要，高度跟着行数走", () => {
    const scape = makeScape();
    findGoal(scape.mainGoal, "h1")!.tags = ["Now"];
    const fence = ["今天跑 5 公里，见 [[跑步]]", "```", "#fence 里的不算", "```"].join("\n");
    const idx = notes({ h1: { text: fence } });
    const c = byId(toCanvas(scape, idx), "h1");
    assert.match(c.text ?? "", /今天跑 5 公里，见 跑步/, "摘要把 wikilink 收成显示文本");
    assert.ok(!/fence/.test(c.text ?? ""), "代码块里的内容不该被当成摘要");
    // 标签不上卡片：颜色已经编码了进度，#tag 在白板上既不能筛也不能点，只会把卡片撑高
    assert.ok(!/#Now/.test(c.text ?? ""));
    assert.equal(c.height, 100 + 24, "标题 + 数值 + 摘要，只比裸卡多一行");
    assert.equal(byId(toCanvas(scape), "h1").height, 100, "没笔记就还是两行");
  });

  it("笔记互引生成带 label 的链接边；指向树外 id 的引用不生成", () => {
    const scape = makeScape();
    const idx = notes(
      { h1: { refs: ["Goalscapes/x.notes/c1.md#计划", "Goalscapes/x.notes/ghost.md"] } },
      { "Goalscapes/x.notes/c1.md": "c1", "Goalscapes/x.notes/ghost.md": "ghost" }
    );
    const edges = toCanvas(scape, idx).edges;
    const e = edges.find((x) => x.id === linkEdgeId("h1", "c1"));
    assert.deepEqual([e?.fromNode, e?.toNode, e?.label], ["h1", "c1", "🔗"]);
    assert.ok(!edges.some((x) => x.id === linkEdgeId("h1", "ghost")), "树里没这个块，线画给谁看");
  });

  it("解析到的笔记生成 file 卡片与连线，且不带 gsId；别的块的笔记不重复挂卡", () => {
    const resolved = notes(
      { h1: { refs: ["笔记/跑步.md", "Goalscapes/x.notes/c1.md"] } },
      { "Goalscapes/x.notes/c1.md": "c1" }
    );
    const c = toCanvas(makeScape(), resolved);
    const f = byId(c, fileNodeId("h1", "笔记/跑步.md"));
    assert.deepEqual([f.type, f.file, f.gsFile], ["file", "笔记/跑步.md", "笔记/跑步.md"]);
    assert.equal(f.gsId, undefined, "文件卡不是任何目标的镜子，挂 gsId 会跟目标卡片抢认领");
    assert.ok(c.edges.some((e) => e.id === fileEdgeId("h1", "笔记/跑步.md")));
    assert.equal(c.nodes.filter((n) => n.gsId === "h1").length, 1);
    assert.equal(
      c.nodes.filter((n) => n.type === "file" && n.file === "Goalscapes/x.notes/c1.md").length,
      0,
      "块间关系已经有 🔗 边了，再挂张文件卡是同一件事说两遍"
    );
  });

  it("块自己的笔记也长一张 file 卡：正文是空的也要有影子", () => {
    const own = "Goalscapes/x.notes/h1.md";
    const c = toCanvas(makeScape(), notes({ h1: { text: "" } }));
    const f = byId(c, fileNodeId("h1", own));
    assert.deepEqual([f.type, f.file, f.gsFile], ["file", own, own]);
    assert.equal(f.gsId, undefined, "它认领的是文件，不是目标");
    assert.ok(c.edges.some((e) => e.id === fileEdgeId("h1", own)), "卡片外侧要连得回源卡片");
    assert.equal(byId(c, "h1").height, 100, "空笔记不撑高目标卡片，但 file 卡照样在");
    assert.ok(!toCanvas(makeScape(), new Map()).nodes.some((n) => n.type === "file"),
      "没笔记文件的块不能在白板上凭空长出笔记");
  });

  it("自己的笔记排第一格，链到的普通笔记接着排，同一篇不挂两次", () => {
    const own = "Goalscapes/x.notes/h1.md";
    const c = toCanvas(makeScape(), notes({ h1: { refs: ["笔记/跑步.md", "笔记/跑步.md"] } }));
    const files = c.nodes.filter((n) => n.type === "file").map((n) => n.file);
    assert.deepEqual(files, [own, "笔记/跑步.md"]);
    assert.equal(c.edges.filter((e) => /^n-/.test(e.id)).length, 2);
  });

  it("拖动过的文件卡位置留住；链接没了，卡片和线一起消失", () => {
    const scape = makeScape();
    const resolved = notes({ h1: { refs: ["a.md"] } });
    const fid = fileNodeId("h1", "a.md");
    const first = refreshCanvas(scape, null, resolved);
    const moved = { ...byId(first, fid), x: 4242, y: -646 };
    const second = refreshCanvas(
      scape,
      { ...first, nodes: first.nodes.map((n) => (n.id === fid ? moved : n)) },
      resolved
    );
    assert.deepEqual([byId(second, fid).x, byId(second, fid).y], [4242, -646], "用户拖过就尊重");

    const third = refreshCanvas(scape, second, new Map());
    assert.ok(!third.nodes.some((n) => n.id === fid), "链接没了卡片不能留着当僵尸");
    assert.ok(!third.edges.some((e) => e.toNode === fid || e.fromNode === fid));
  });

  it("用户自己拖进来的文件卡不算派生卡", () => {
    const merged = refreshCanvas(makeScape(), { nodes: [userFile("u-1")], edges: [] });
    assert.ok(merged.nodes.some((n) => n.id === "u-1"), "本轮没生成它，也不能把它当成鬼卡删掉");
  });

  it("链接边认前缀不认两端：本轮没生成就删，用户手画的同样两个端点要留", () => {
    const existing: JsonCanvas = {
      nodes: toCanvas(makeScape()).nodes,
      edges: [
        { id: linkEdgeId("h1", "c1"), fromNode: "h1", toNode: "c1", label: "🔗" },
        { id: "u-2", fromNode: "h1", toNode: "c1" },
      ],
    };
    const merged = refreshCanvas(makeScape(), existing);
    assert.ok(!merged.edges.some((e) => e.id === linkEdgeId("h1", "c1")), "残线会一直挂着，两端卡片都还在");
    assert.ok(merged.edges.some((e) => e.id === "u-2"), "随机 id 是用户画的，动不得");
  });

  it("源卡片被拖远之后新出现的文件卡落在源卡片旁边", () => {
    const scape = makeScape();
    const resolved = notes({ h1: { refs: ["b.md"] } });
    const existing: JsonCanvas = {
      nodes: toCanvas(scape).nodes.map((n) => ({ ...n, x: n.x + 5000, y: n.y + 3000 })),
      edges: [],
    };
    const merged = refreshCanvas(scape, existing, resolved);
    const f = byId(merged, fileNodeId("h1", "b.md"));
    const h = byId(merged, "h1");
    assert.ok(
      Math.abs(f.x - h.x) < 600 && Math.abs(f.y - h.y) < 600,
      "不该留在算法位置、跟源卡片隔空牵一条线"
    );
  });

  it("带派生卡片的镜像同样幂等", () => {
    const scape = makeScape();
    const resolved = notes({ h1: { refs: ["a.md", "b.md"] }, career: { refs: ["c.md"] } });
    const once = refreshCanvas(scape, toCanvas(scape, resolved), resolved);
    const twice = refreshCanvas(scape, once, resolved);
    assert.equal(canvasToJson(twice), canvasToJson(once));
  });
});

describe("快照可信度：内存里那份只有加载出卡片才算数", () => {
  const doc = (n: number): JsonCanvas => ({
    nodes: Array.from({ length: n }, (_, i) => card(`k${i}`, `k${i}`)),
    edges: [],
  });

  it("刚打开的 canvas 视图 getData() 会返回 0 张卡，这时必须退回磁盘那份", () => {
    const disk = doc(3);
    assert.equal(trustedSnapshot(doc(0), disk), disk);
    assert.equal(trustedSnapshot(null, disk), disk);
    const live = doc(4);
    assert.equal(trustedSnapshot(live, disk), live, "内存里有卡片就以内存为准（它领先磁盘几十秒）");
    assert.equal(trustedSnapshot(null, null), null);
  });

  it("不可信快照必须被挡掉，否则整份文件按算法重画、用户布局全没", () => {
    const hand = toCanvas(makeScape()).nodes.map((n) => ({ ...n, x: n.x + 3000, y: n.y - 2000 }));
    const existing: JsonCanvas = { nodes: hand, edges: [] };
    const saved = refreshCanvas(makeScape(), trustedSnapshot(doc(0), existing));
    const wrecked = refreshCanvas(makeScape(), doc(0));
    assert.equal(byId(saved, "health").x, byId(existing, "health").x, "挡下来之后手工位置保住");
    assert.notEqual(byId(wrecked, "health").x, byId(existing, "health").x, "不挡就被按算法重画");
  });

  it("坏 JSON / 缺字段一律解析为 null，由调用方决定退化", () => {
    assert.equal(parseCanvasJson("{not json"), null);
    assert.equal(parseCanvasJson(JSON.stringify({ nodes: "nope" })), null);
    assert.deepEqual(parseCanvasJson(JSON.stringify({ nodes: [{ id: "a" }, { x: 1 }] }))?.nodes.length, 1);
  });
});
