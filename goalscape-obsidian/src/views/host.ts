// src/views/host.ts
// 视图层对插件的全部依赖面。刻意不 import main.ts：组合根与视图之间只隔这张窄面，
// 视图拿不到命令注册、设置读写、导出下载这些它不该碰的东西。
// 要加成员先问一句：这是视图的职责，还是它顺手想替 main.ts 干活？

import type { App } from "obsidian";
import type { GoalTreeStore } from "../data/goalTree";
import type { NoteStore } from "../data/noteFiles";
import type { Tone } from "../data/palette";
import type { SubtreeClipboard } from "./radialMenu";

export interface GoalscapeHost {
  /** infoPanel 不是 ItemView，它要的 MarkdownView / metadataCache 只能从这里拿 */
  readonly app: App;
  readonly store: GoalTreeStore;
  /** 每块笔记的索引与 .md 文件门面 */
  readonly notes: NoteStore;
  /** 跨视图的子系统粘贴板 */
  readonly clipboard: SubtreeClipboard;
  /** 当前配色基调（由设置页滑块换算而来） */
  readonly tone: Tone;

  listGoalscapes(): string[];
  switchGoalscape(path: string): Promise<void>;
  openView(type: string): Promise<void>;

  /** 白板镜像：切换器靠它画小圆点，Canvas 项点开的是这张图 */
  readonly canvasStale: boolean;
  openCanvas(): Promise<void>;
  exportCanvas(): Promise<void>;
}
