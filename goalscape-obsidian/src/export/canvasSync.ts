// src/export/canvasSync.ts
// GoalScape → JSON Canvas (.canvas) 的**单向**镜像：树 → 白板。
// 白板侧属于用户的只有三样：卡片位置、用户自己加的卡片、用户自己画的连线。
// 文字/颜色/父子结构一律由树派生 —— 一个东西只能有一个主人，两边都能改就两边都会丢
// （白板→数据 的反向回写已整块删除，理由见文件末尾的注释）。

import { GoalNode, GoalScape, NoteIndex, NoteInfo, flattenTree } from "../data/types";
import { bandScaleOf, childShares } from "../geometry/radialGeometry";
import { firstLine, outgoingRefs } from "../data/notes";

/**
 * Obsidian 会把未知键收进节点的 unknownData 并在保存时原样吐回（实测），
 * 所以这里允许任意键穿过；已知键（id/type/x/y/width/height/text/color）由 Obsidian 自己维护，
 * 我们的机器字段一律用 gs 前缀，避免和它抢同一个名字。
 */
export interface CanvasNode {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  color?: string;
  [key: string]: unknown;
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  [key: string]: unknown;
}

export interface JsonCanvas {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

/** 用户在白板里唯一保留下来的东西：位置与大小。文字/颜色是树派生的，不算用户资产。 */
const LAYOUT_KEYS = ["x", "y", "width", "height"] as const;
/** 连线的用户资产同理：他把哪一边、哪个端点连起来都是布局，镜像不该抹平 */
const EDGE_LAYOUT_KEYS = ["fromSide", "toSide", "fromEnd", "toEnd"] as const;

/** 我们生成的连线 id；Obsidian 自己加的连线是随机 id，两种要分得开 */
export function generatedEdgeId(childId: string): string {
  return `e-${childId}`;
}

/** 块间链接边（笔记互引派生）与"目标 → vault 笔记"边的 id */
export function linkEdgeId(fromId: string, toId: string): string {
  return `x-${fromId}-${toId}`;
}
export function fileEdgeId(goalId: string, filePath: string): string {
  return `n-${goalId}-${hashStr(filePath)}`;
}
export function fileNodeId(goalId: string, filePath: string): string {
  return `f-${goalId}-${hashStr(filePath)}`;
}

/** FNV-1a：路径进 id 只要稳定、不撞，不需要密码学强度 */
function hashStr(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

const PROGRESS_COLORS: Record<number, string> = {
  0: "1", // red
  1: "2", // orange
  2: "3", // yellow
  3: "4", // green
};

function progressToPreset(progress: number): string {
  const idx = Math.min(3, Math.floor(progress / 25));
  return PROGRESS_COLORS[idx] ?? "1";
}

const NODE_W = 220;
const NODE_H = 100;
/** 卡片每多一行正文就多给这么多高度：text 是派生字段，行数是它自己算出来的 */
const LINE_H = 24;

/** 笔记文件卡落在源卡片径向外侧这么多像素，多张则沿垂直方向并排 */
const FILE_OUT = 300;
const FILE_SIDE_STEP = 170;
const FILE_W = 260;
const FILE_H = 120;

interface Built {
  doc: JsonCanvas;
  /** 卡片 id → 父卡片 id：新卡片要落在自己父卡片附近才不算乱丢 */
  parentOf: Map<string, string>;
}

/**
 * 卡片正文：标题 + 数值行，有笔记再追加一行摘要。
 * 只追加摘要这一行 —— 白板上能看见"这块到底在讲什么"就够了；
 * 标签在这儿是纯噪音（卡片颜色已经编码进度，标签既不能筛也不能点），只会把卡片撑高。
 */
function cardLines(node: GoalNode, note?: NoteInfo): string[] {
  const lines = [
    `**${node.title}**`,
    `占父级 ${node.importance}% · 进度 ${node.progress ?? 0}%`,
  ];
  const summary = firstLine(note?.text ?? "");
  if (summary) lines.push(summary);
  return lines;
}

/** 一轮 buildCanvas 的累加器：三段 emit 都往这里 push，省掉每个函数重复传五个参数 */
interface Sink {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  parentOf: Map<string, string>;
  notes?: NoteIndex;
  /** 链接边的目标要真在这张图里：goalId 由笔记索引反查得到，而索引只在面板刷新时重建，
   *  删掉一个块之后它可能还是旧的 —— 指向不存在的卡片就成了一条悬空边 */
  live: Set<string>;
}

/** 目标卡片本身，加上它到父卡片的那条生成边 */
function emitCard(
  sink: Sink, node: GoalNode, depth: number, x: number, y: number, parentId?: string
): void {
  const lines = cardLines(node, sink.notes?.get(node.id));
  // JSON Canvas 里 x/y 是卡片的中心，不是左上角（Obsidian 按中心解释这个数）
  sink.nodes.push({
    id: node.id,
    type: "text",
    x: Math.round(x),
    y: Math.round(y),
    width: NODE_W,
    height: NODE_H + LINE_H * (lines.length - 2),
    text: lines.join("\n"),
    color: progressToPreset(node.progress ?? 0),
    // 机器字段：Obsidian 不认识就原样留住（实测），镜像靠它认出哪张卡属于哪个目标
    gsId: node.id,
    gsDepth: depth,
  });
  if (parentId) {
    sink.edges.push({ id: generatedEdgeId(node.id), fromNode: parentId, toNode: node.id });
    sink.parentOf.set(node.id, parentId);
  }
}

/**
 * 这块自己的笔记 + 笔记里链到的其他 vault 文件，都长成 file 卡挂在卡片外侧。
 * "这块有笔记"本身就是镜像该说的话，不该等到笔记里出现链接才留影子。
 * 指向**别的块的笔记**的那些不在这里 —— 对方卡片外侧已经有它自己的 file 卡，
 * 这条关系由 emitLinkEdges 的 🔗 边画；解析不到的幽灵链接根本不在 refs 里。
 */
function emitFileCards(sink: Sink, node: GoalNode, x: number, y: number): void {
  const own = sink.notes?.get(node.id);
  const files = [
    ...(own ? [own.path] : []),
    ...(own?.refs ?? [])
      .filter((r) => !r.goalId)
      .map((r) => r.path)
      .filter((p, i, a) => a.indexOf(p) === i),
  ];
  if (!files.length) return;

  // 径向外侧、沿切线并排：文件卡贴在属于自己的那张卡外面一圈，而不是散落全图
  const len = Math.hypot(x, y);
  const ux = len > 1 ? x / len : 1;
  const uy = len > 1 ? y / len : 0;
  files.forEach((file, k) => {
    const fid = fileNodeId(node.id, file);
    const lateral = (k - (files.length - 1) / 2) * FILE_SIDE_STEP;
    const fx = x + ux * FILE_OUT - uy * lateral;
    const fy = y + uy * FILE_OUT + ux * lateral;
    sink.nodes.push({
      id: fid,
      type: "file",
      file,
      x: Math.round(fx),
      y: Math.round(fy),
      width: FILE_W,
      height: FILE_H,
      // gsFile 而非 gsId：文件卡不是某个目标的镜子，挂 gsId 会跟目标卡片抢认领、
      // 触发"复制卡降级"分支，两张卡互相把对方挤成便签
      gsFile: file,
      // 相对源卡片的偏移：拖动过源卡片之后，新出现的文件卡要跟着源卡片而不是算法位置
      gsOx: Math.round(fx - x),
      gsOy: Math.round(fy - y),
    });
    sink.edges.push({ id: fileEdgeId(node.id, file), fromNode: node.id, toNode: fid });
    sink.parentOf.set(fid, node.id);
  });
}

/** 块间边只从笔记互引里来：B 的笔记 [[ 了 A 的笔记才有一条线，关系有出处 */
function emitLinkEdges(sink: Sink, node: GoalNode): void {
  const linkedGoals = new Set(
    (sink.notes ? outgoingRefs(sink.notes, node.id) : []).map((r) => r.goalId as string)
  );
  for (const to of linkedGoals) {
    if (!sink.live.has(to)) continue;
    sink.edges.push({
      id: linkEdgeId(node.id, to),
      fromNode: node.id,
      toNode: to,
      label: "🔗",
      color: progressToPreset(node.progress ?? 0),
    });
  }
}

function buildCanvas(scape: GoalScape, notes?: NoteIndex): Built {
  const sink: Sink = {
    nodes: [],
    edges: [],
    parentOf: new Map<string, string>(),
    notes,
    live: new Set(flattenTree(scape.mainGoal).map((n) => n.id)),
  };
  const R = 600;

  const walk = (
    node: GoalNode,
    depth: number,
    startAngle: number,
    endAngle: number,
    rInner: number,
    parentId?: string
  ): void => {
    const mid = (startAngle + endAngle) / 2;
    // 半径与角度都按放射图同一套规则递推，白板布局才和图对得上
    const rOuter = rInner + bandScaleOf(node) * R;
    const radius = depth === 0 ? 0 : (rInner + rOuter) / 2;
    const x = Math.cos(mid) * radius;
    const y = Math.sin(mid) * radius;

    emitCard(sink, node, depth, x, y, parentId);
    emitFileCards(sink, node, x, y);
    emitLinkEdges(sink, node);

    const shares = childShares(node);
    if (!shares.some((s) => s > 0)) return;
    let acc = startAngle;
    const span = endAngle - startAngle;
    node.children.forEach((c, i) => {
      const cSpan = shares[i] * span;
      walk(c, depth + 1, acc, acc + cSpan, rOuter, node.id);
      acc += cSpan;
    });
  };

  walk(scape.mainGoal, 0, 0, Math.PI * 2, 0);
  return { doc: { nodes: sink.nodes, edges: sink.edges }, parentOf: sink.parentOf };
}


export function toCanvas(scape: GoalScape, notes?: NoteIndex): JsonCanvas {
  return buildCanvas(scape, notes).doc;
}

export function canvasToJson(canvas: JsonCanvas): string {
  return JSON.stringify(canvas, null, 2);
}

/** 白板文件解析：坏 JSON / 缺字段都当"没有可合并的旧文件"，由调用方决定退化行为 */
export function parseCanvasJson(raw: string): JsonCanvas | null {
  try {
    const v = JSON.parse(raw) as Partial<JsonCanvas>;
    if (!v || !Array.isArray(v.nodes)) return null;
    return {
      nodes: v.nodes.filter((n): n is CanvasNode => !!n && typeof n.id === "string"),
      edges: (Array.isArray(v.edges) ? v.edges : []).filter(
        (e): e is CanvasEdge => !!e && typeof e.fromNode === "string" && typeof e.toNode === "string" && typeof e.id === "string"
      ),
    };
  } catch {
    return null;
  }
}

/**
 * 内存里那份白板只有真加载出卡片才可信。
 * 实测：刚打开的 canvas 视图 `getData()` 会返回 nodes:0，拿它当快照等于把整份文件按算法重画 ——
 * 用户手工摆的位置和他自己的便签会一起消失。这时退回磁盘那份。
 */
export function trustedSnapshot(
  live: JsonCanvas | null,
  disk: JsonCanvas | null
): JsonCanvas | null {
  if (live && live.nodes.length > 0) return live;
  return disk;
}

/** 卡片声称它代表哪个目标：新格式看 gsId，本改动之前导出的旧白板退化成"节点 id 就是目标 id" */
function claimedGoal(node: CanvasNode): string {
  return typeof node.gsId === "string" ? node.gsId : node.id;
}

/** 两张矩形卡片（含 padding）是否重叠。x/y 按 JSON Canvas 的中心的语义比 */
function collides(card: CanvasNode, others: CanvasNode[], pad: number): boolean {
  return others.some(
    (o) =>
      Math.abs(card.x - o.x) < (card.width + o.width) / 2 + pad &&
      Math.abs(card.y - o.y) < (card.height + o.height) / 2 + pad
  );
}

const NEW_CARD_PAD = 24;
/** 算法位置被占了就沿"父→子"方向往外让，每档这么多像素 */
const NEW_CARD_STEP = 140;
const NEW_CARD_RINGS = 5;

/**
 * 给一张新卡片找落点：先试算法位置（放射布局本来就该在那），被占了就沿父→子的射线
 * 往外、再往两侧让。不动任何已有卡片 —— "布局不乱"优先级高于"位置最优"。
 */
function placeNewCard(
  card: CanvasNode,
  parent: CanvasNode | undefined,
  occupied: CanvasNode[]
): CanvasNode {
  if (!parent || !collides(card, occupied, NEW_CARD_PAD)) return card;
  const dx = card.x - parent.x;
  const dy = card.y - parent.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  // 垂直于射线的两个方向，用来躲开同级的邻居
  const px = -uy;
  const py = ux;
  for (let ring = 1; ring <= NEW_CARD_RINGS; ring++) {
    for (const lateral of [0, -1, 1, -2, 2]) {
      const cand: CanvasNode = {
        ...card,
        x: Math.round(card.x + ux * ring * NEW_CARD_STEP + px * lateral * NEW_CARD_STEP),
        y: Math.round(card.y + uy * ring * NEW_CARD_STEP + py * lateral * NEW_CARD_STEP),
      };
      if (!collides(cand, occupied, NEW_CARD_PAD)) return cand;
    }
  }
  return card;
}

/**
 * 边是不是我们生成的那一族：id 前缀就是所有权凭证。
 * Obsidian 自建的边是十六进制随机 id，永远不会撞这四个前缀，所以认前缀比认内容可靠。
 */
function isGeneratedEdge(id: string): boolean {
  return /^(e|x|n)-/.test(id);
}

/**
 * 树 → 白板：重画派生字段，留住用户的东西。
 * 留住：已有卡片的位置尺寸、用户自己的卡片（便签/文件卡）和它们的连线。
 * 删掉：带 gsId 但树里已经没这个目标的卡片 —— 那是上次镜像留下的鬼卡，不删就永远挂着；
 *       带 gsFile 却不在本轮生成集合里的笔记卡 —— 链接没了，卡片跟着消失（同一套规矩）；
 *       本轮没再生成的生成边（e-/x-/n-）—— 否则删掉的链接会在白板上留一条幽灵线。
 * 新卡片：落在父卡片附近且不压到任何卡片。
 */
export function refreshCanvas(
  scape: GoalScape,
  existing: JsonCanvas | null,
  notes?: NoteIndex
): JsonCanvas {
  const { doc: fresh, parentOf } = buildCanvas(scape, notes);
  if (!existing) return fresh;

  const liveIds = new Set(flattenTree(scape.mainGoal).map((n) => n.id));
  const freshIds = new Set(fresh.nodes.map((n) => n.id));
  const mirrored = new Map<string, CanvasNode>();
  /** 上一轮生成的笔记文件卡，按自己的 id 认领自己（不是某个目标的镜子，不能进 mirrored） */
  const fileCards = new Map<string, CanvasNode>();
  const extras: CanvasNode[] = [];
  for (const n of existing.nodes) {
    if (typeof n.gsFile === "string") {
      if (freshIds.has(n.id)) fileCards.set(n.id, n);
      continue;
    }
    const goal = claimedGoal(n);
    if (liveIds.has(goal)) {
      if (!mirrored.has(goal)) {
        mirrored.set(goal, n);
        continue;
      }
      // 两张卡都说是同一个目标（Obsidian 里复制卡片会把 gsId 一起复制）：
      // 第一张当镜子，多出来的抹掉认领关系降级成便签，否则下一轮它又来抢
      const copy = { ...n };
      delete copy.gsId;
      delete copy.gsDepth;
      extras.push(copy);
      continue;
    }
    // 带 gsId 却认不出目标 = 树里删掉的目标留下的鬼卡；没 gsId 的是用户自己的卡片
    if (typeof n.gsId === "string") continue;
    extras.push(n);
  }

  const nodes: CanvasNode[] = [];
  for (const f of fresh.nodes) {
    const o = mirrored.get(f.id) ?? fileCards.get(f.id);
    if (!o) {
      const parentId = parentOf.get(f.id);
      const parentCard = nodes.find((c) => c.id === parentId);
      // 笔记卡落在"源卡片现在真的在哪"外面一圈，而不是源卡片的算法位置：
      // 整图被拖远之后，新出现的笔记卡若留在老地方就成了隔空牵线的一格
      const cand: CanvasNode =
        parentCard && typeof f.gsOx === "number" && typeof f.gsOy === "number"
          ? { ...f, x: parentCard.x + f.gsOx, y: parentCard.y + f.gsOy }
          : f;
      nodes.push(placeNewCard(cand, parentCard, [...nodes, ...extras]));
      continue;
    }
    const merged: CanvasNode = { ...o, ...f };
    for (const k of LAYOUT_KEYS) {
      const v = o[k];
      if (typeof v === "number" && Number.isFinite(v)) merged[k] = v;
    }
    nodes.push(merged);
  }

  // 用户自己的卡片也在 kept 里：他画的连线有一头就落在便签上，漏掉就把这条线判成孤儿删了
  const kept = new Set([...nodes, ...extras].map((n) => n.id));
  const ids = new Set(fresh.edges.map((e) => e.id));
  const pairs = new Set(fresh.edges.map((e) => `${e.fromNode}>${e.toNode}`));
  const prevEdge = new Map(existing.edges.map((e) => [e.id, e]));
  return {
    nodes: [...nodes, ...extras],
    edges: [
      // 生成边每次都以 fresh 为准（端点/存在性由树决定），但 side 与 end 要接着旧文档那份：
      // 用户在 Obsidian 里把线拖到卡片左侧，下一次镜像不该把它弹回默认的 bottom→top
      ...fresh.edges.map((e) => {
        const o = prevEdge.get(e.id);
        if (!o) return e;
        const merged: CanvasEdge = { ...e };
        for (const k of EDGE_LAYOUT_KEYS) if (typeof o[k] === "string") merged[k] = o[k];
        return merged;
      }),
      ...existing.edges.filter(
        (e) =>
          !isGeneratedEdge(e.id) &&
          !ids.has(e.id) &&
          !pairs.has(`${e.fromNode}>${e.toNode}`) &&
          kept.has(e.fromNode) &&
          kept.has(e.toNode)
      ),
    ],
  };
}

// 白板 → 数据的方向（diffCanvas / applyCanvasPlan / stampAdoptedCards / 预览模态框）实现过、
// 实测过，然后整块删了，原因记在这别再走回头路：
// 1) 导出会以树为准重画 text 和 `e-<子id>` 这条边 —— 同 id 的用户改动被静默丢掉，
//    而"改完白板先点一次导出"是极其自然的动作，等于一条随时会吃掉用户改动的路径；
// 2) 兄弟顺序只能拿 .canvas 的节点数组顺序来判，而那是 Obsidian 的创建/图层顺序，
//    跟用户眼睛看到的排列无关 —— 用真实文件复现过一条用户从未做过的"重排 4 个兄弟"；
// 3) 位置在 GoalNode 里无处存放（不加 x/y 是项目定死的），所以白板的表达力天生只出不进。
