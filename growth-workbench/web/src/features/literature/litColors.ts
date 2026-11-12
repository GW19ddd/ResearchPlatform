/**
 * 文献模块的统一色板 —— 关联图（GraphView.tsx 里那套 Litmaps 配色）就是基准。
 *
 * 用法约定（与 .workbuddy/memory 锁定，勿改）：
 *  - style 里直接取精确色：style={{ color: LM_TITLE }} / style={{ background: LM_BORDER }}。
 *  - className 里**不带括号**地写：`className={`text-${LM_TITLE}`}`。
 *    这是项目刻意写法：Tailwind 不会把 `text-#16213a` 编译成样式（属无效类、静默无效果），
 *    文字色由文献页外壳 `.lit-scope`（index.css 把 --wb-accent* 归一到皇家蓝族）继承兜底。
 *  - ⚠️ 不要把 className 改成带括号的 `text-[${LM_TITLE}]`：那会覆盖 .lit-scope 的蓝色、
 *    破坏文献模块统一观感（已截图验收的现状）。需要精确色时改用上面的 style 写法。
 *  - 别再往这些文件里写 var(--wb-accent) / 裸 hex —— 全站令牌是靛蓝，
 *    文献模块要的是皇家蓝，两套混在一屏里会显得脏。
 *  - 本模块之外（画布 / 实验 / 社区）继续用 index.css 的 --wb-* 令牌。
 *
 * ui.tsx 的原语（Btn / Input / Pill / Progress…）不需要改：文献页外壳
 * 套了 .lit-scope，变量在 index.css 里已归一到同一族蓝。
 */

export const LM_BLUE = '#2563eb'
export const LM_BLUE_DEEP = '#1d4ed8'
export const LM_BLUE_SOFT = '#eff4ff'
export const LM_SEED_FILL = '#333d4b'
export const LM_TITLE = '#16213a'
export const LM_TEXT_STRONG = '#1a2b4c'
export const LM_TEXT = '#3c4657'
export const LM_BODY = '#4b5563'
export const LM_MUTED = '#6b7280'
export const LM_FAINT = '#8a94a6'
export const LM_FAINTEST = '#9aa3b2'
export const LM_BORDER = '#e7eaf0'
export const LM_BORDER_STRONG = '#cfd6e0'
export const LM_DIVIDER = '#d7dde8'
export const LM_GRID = '#e3e8ef'
export const LM_CHIP_BG = '#e9eef5'
export const LM_CHIP_BORDER = '#c9d3e0'

/* 引文网络里的节点与高亮连线：与关联图 GraphView 的节点描边一致 */
export const LM_NODE_STROKE = '#4285f4'
export const LM_EDGE_HOT = '#a9c6f5'
export const LM_HALO = '#bcd2fa'
