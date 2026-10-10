// src/data/notes.ts
// 笔记相关的纯逻辑：首行摘要、块间关系（从笔记互引里现扫）。
// 零 obsidian 依赖（分层守卫锁死）——正文与出链由 NoteStore 读文件后以 NoteIndex 交进来，
// 这一层只做不碰文件系统的那部分。

import { NoteIndex, NoteRef } from "./types";

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

/**
 * 出向块间关系：这个块的笔记引用了哪些**别的块**的笔记（带锚点）。
 * 弦线、面板 chips、白板链接边的唯一来源 —— 关系必须有出处（正文里真写着那条 wikilink），
 * 手工维护的 id 数组没有出处，2026-10-10 翻案删掉了。
 */
export function outgoingRefs(index: NoteIndex, id: string): NoteRef[] {
  const out: NoteRef[] = [];
  for (const r of index.get(id)?.refs ?? []) {
    if (!r.goalId || r.goalId === id) continue;
    if (!out.some((x) => x.goalId === r.goalId && x.anchor === r.anchor)) out.push(r);
  }
  return out;
}

/** 入向：哪些块的笔记引用了这个块的笔记。锚点落在**本块**笔记里（对方是引到某一节） */
export function incomingRefs(index: NoteIndex, id: string): Array<{ fromId: string; ref: NoteRef }> {
  if (!index.has(id)) return [];
  const out: Array<{ fromId: string; ref: NoteRef }> = [];
  for (const [fromId, info] of index) {
    if (fromId === id) continue;
    for (const r of info.refs) {
      if (r.goalId !== id) continue;
      if (!out.some((x) => x.fromId === fromId && x.ref.anchor === r.anchor)) out.push({ fromId, ref: r });
    }
  }
  return out;
}
