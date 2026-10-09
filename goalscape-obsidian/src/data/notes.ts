// src/data/notes.ts
// 笔记相关的纯逻辑：首行摘要、反链扫描、links 清洗。
// 零 obsidian 依赖（分层守卫锁死）——正文与出链由 NoteStore 读文件后以 NoteIndex 交进来，
// 这一层只做不碰文件系统的那部分。

import { GoalNode, flattenTree } from "./types";

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
