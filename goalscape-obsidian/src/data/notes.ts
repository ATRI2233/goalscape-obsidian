// src/data/notes.ts
// notes 相关的全部纯逻辑：wikilink 目标解析、tag 抽取、首行摘要、反链扫描、links 清洗。
// 零 obsidian 依赖（分层守卫锁死）——链接是否真的存在于 vault 由视图/导出层拿 metadataCache 判定。

import { GoalNode, flattenTree } from "./types";

/**
 * 跳过 ``` / ~~~ 围栏代码块后逐行扫描，对每行"非代码"文本跑 fn。
 * 代码块里的 [[x]] / #tag 是示例不是链接，收进来会造出点不动的幽灵连接。
 */
function eachRealLine(md: string, fn: (line: string) => void): void {
  let inFence = false;
  for (const line of md.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) fn(line);
  }
}

/**
 * 提取 [[wikilink]] 的链接目标。
 * - `![[嵌入]]` 不算链接目标（它渲染成内容，不建立关系）；
 * - `[[目标|别名]]` 只取目标；`[[目标#小节]]` 只取目标（小节不参与解析）。
 * 返回顺序 = 出现顺序，重复去重。
 */
export function parseWikiTargets(md: string): string[] {
  const out: string[] = [];
  if (!md) return out;
  eachRealLine(md, (line) => {
    // (?<!!) 排除嵌入：前一个字符是 ! 的 [[ 属于 ![[
    for (const m of line.matchAll(/(?<!!)\[\[([^\]|#]+?)(?:#[^|]*)?(?:\|[^\]]*)?\]\]/g)) {
      const t = m[1].trim();
      if (t && !out.includes(t)) out.push(t);
    }
  });
  return out;
}

/**
 * 抽取 #tag（不带 # 前缀返回），与 node.tags 合流时由调用方决定顺序。
 * 词内字符按 Obsidian 的规则放宽到字母/数字/下划线/连字符/斜杠，
 * 但纯数字（#123）不是标签、行首 `# ` 是标题不是 tag，都不收。
 */
export function parseTags(md: string): string[] {
  const out: string[] = [];
  if (!md) return out;
  eachRealLine(md, (line) => {
    for (const m of line.matchAll(/(^|[\s(])#([\p{L}_][\p{L}\p{N}_/-]*)/gu)) {
      if (!out.includes(m[2])) out.push(m[2]);
    }
  });
  return out;
}

/** notes 的第一行正文（跳过空行、标题、围栏标记），截 max 字，用于 tooltip / 白板卡片 / 导出 */
export function firstLine(md: string, max = 60): string {
  if (!md) return "";
  let inFence = false;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line || line.startsWith("#")) continue;
    // 摘要给人看，markdown 记号先剥掉：粗体/斜体/反引号/链接只剩显示名
    const plain = line
      .replace(/!?\[\[([^\]|]+?)(?:[#[|][^\]]*)?\]\]/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_`>]/g, "")
      .trim();
    if (!plain) continue;
    return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
  }
  return "";
}

/** 谁链接了 id：全树扫一遍，返回引用方节点（不含自己），顺序 = 深度优先序 */
export function backlinks(root: GoalNode, id: string): GoalNode[] {
  return flattenTree(root).filter((n) => n.id !== id && (n.links ?? []).includes(id));
}

/** node.tags 与 notes 里 #tag 的合流（只读，不落盘）：字段在前、正文在后 */
export function effectiveTags(node: GoalNode, md?: string): string[] {
  // Obsidian 的 tag 大小写不敏感，所以 #now 和字段里的 Now 是同一个：按小写去重、保留首次出现的写法
  const seen = new Set(node.tags.map((t) => t.toLowerCase()));
  const out = [...node.tags];
  for (const t of parseTags(md ?? node.notes ?? "")) {
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/**
 * links 的清洗规则（读档与落盘前各跑一次，同 normalize 的 color 规矩）：
 * 去重、剔除自链、剔除树里已经不存在的目标 id。
 * 空数组删键 —— 不留一个"空连接"的第三种状态。
 */
export function pruneLinks(root: GoalNode): void {
  const alive = new Set(flattenTree(root).map((n) => n.id));
  for (const n of flattenTree(root)) {
    if (!n.links) continue;
    const kept: string[] = [];
    for (const id of n.links) {
      if (id !== n.id && alive.has(id) && !kept.includes(id)) kept.push(id);
    }
    if (kept.length) n.links = kept;
    else delete n.links;
  }
}
