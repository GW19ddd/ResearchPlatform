/**
 * recharts 专用图表色令牌（单一来源）。
 *
 * recharts 把 stroke/fill 写成 SVG 属性，var() 在 SVG 属性里不生效，
 * 只能用十六进制字面量；这里是 index.css `:root --wb-*` 的同步副本。
 * 改 index.css 的 --wb-accent / --wb-ok / --wb-warn / --wb-danger /
 * --wb-muted / --wb-border 时，必须同步改这里。
 */

export const C_ACCENT = '#5145e0' // --wb-accent
export const C_OK = '#067a45' // --wb-ok
export const C_WARN = '#a15c07' // --wb-warn
export const C_DANGER = '#c02b21' // --wb-danger
export const C_AXIS = '#6b7280' // --wb-muted
export const C_GRID = '#ebecf0' // --wb-border
