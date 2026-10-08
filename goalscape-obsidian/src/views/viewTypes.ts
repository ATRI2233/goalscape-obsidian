// src/views/viewTypes.ts
// 视图类型集中一处：三个视图自身、插件注册、以及呈现方式切换器都从这里取常量。
// 放在视图模块里会让 viewSwitcher 反向 import radialView，构成循环依赖 ——
// esbuild 打包时 radialView 尚未初始化完就被读常量，拿到的是 undefined。

export const VIEW_RADIAL = "goalscape-radial-view";
export const VIEW_LIST = "goalscape-list-view";
export const VIEW_GANTT = "goalscape-gantt-view";

export interface ViewOption {
  type: string;
  label: string;
  /** lucide 图标名，切换器用它画分段按钮 */
  icon: string;
}

/** 白板不是本插件注册的 ItemView，而是 vault 里的 .canvas 文件，用一个哨兵值代表 */
export const VIEW_CANVAS = "goalscape-canvas-file";

/** 分段按钮的从左到右顺序即切换顺序，前三项与命令面板的三个 open-*-goalscape 命令一一对应 */
export const VIEW_OPTIONS: ViewOption[] = [
  { type: VIEW_RADIAL, label: "Radial map", icon: "target" },
  { type: VIEW_LIST, label: "Goal list", icon: "list" },
  { type: VIEW_GANTT, label: "Gantt", icon: "calendar" },
  { type: VIEW_CANVAS, label: "Canvas (白板)", icon: "layout-grid" },
];
