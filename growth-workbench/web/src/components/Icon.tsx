/**
 * 全站图标：一套手写 SVG，零依赖。
 *
 * 之前各处用的是 Unicode 符号（✦ ❐ ⌗ ▤ ★ ⚙ ⌕ × ▸ …），问题在于：
 *   - 不同系统字体里这些码位长相不一，Windows 上还会掉进 emoji 字体变彩色；
 *   - 描边粗细、视觉重量完全不可控，跟 13px 的中文正文凑不到一起；
 *   - 屏幕阅读器会把「✦」读成「黑星」，属于噪音。
 * 这里统一 24×24 视框 + currentColor 描边，尺寸随字号走，aria-hidden 默认开。
 */
import { ReactElement, SVGProps } from 'react'

export type IconName =
  | 'home'
  | 'sun'
  | 'sparkle'
  | 'book'
  | 'beaker'
  | 'file'
  | 'hexagon'
  | 'clock'
  | 'phone'
  | 'star'
  | 'heart'
  | 'bookmark'
  | 'users'
  | 'message'
  | 'gear'
  | 'bell'
  | 'pencil'
  | 'chevronLeft'
  | 'chevronRight'
  | 'chevronDown'
  | 'chevronUp'
  | 'chevronsLeft'
  | 'chevronsRight'
  | 'close'
  | 'search'
  | 'check'
  | 'checkSquare'
  | 'minus'
  | 'alert'
  | 'info'
  | 'menu'
  | 'panel'
  | 'arrowRight'
  | 'arrowUp'
  | 'plus'
  | 'refresh'
  | 'download'
  | 'trash'
  | 'send'
  | 'user'
  | 'logout'
  | 'lock'
  | 'eye'
  | 'eyeOff'
  | 'shield'
  | 'compass'
  | 'map'
  | 'library'
  | 'radar'
  | 'quill'
  | 'gitBranch'
  | 'wand'
  | 'apps'
  | 'link'
  | 'quote'
  | 'chart'
  | 'slides'
  | 'clipboardCheck'
  | 'copy'
  | 'reply'
  | 'scan'
  | 'maximize'
  | 'minimize'
  | 'pipeline'
  | 'layers'
  | 'database'
  | 'image'
  | 'notebook'
  | 'inbox'
  | 'play'
  | 'code'
  | 'sigma'
  | 'bookOpen'
  | 'lightbulb'
  | 'network'
  | 'target'
  | 'grid'
  | 'route'
  | 'award'
  | 'sprout'
  | 'paperclip'
  | 'folder'
  | 'mic'
  | 'hand'
  | 'bolt'
  | 'cpu'
  | 'crown'

const P: Record<IconName, ReactElement> = {
  home: (
    <>
      <path d="M4 10.5L12 4l8 6.5" />
      <path d="M6.2 9.6V20h11.6V9.6" />
      <path d="M10 20v-5.5h4V20" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </>
  ),
  sparkle: (
    <>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path d="M18.5 15.5l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z" />
    </>
  ),
  book: (
    <>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </>
  ),
  beaker: (
    <>
      <path d="M4.5 3h15" />
      <path d="M6.5 3v15.5A2.5 2.5 0 0 0 9 21h6a2.5 2.5 0 0 0 2.5-2.5V3" />
      <path d="M6.8 13h10.4" />
    </>
  ),
  file: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M9 13h6M9 17h4" />
    </>
  ),
  hexagon: (
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5.5l4 2" />
    </>
  ),
  phone: (
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
  ),
  star: <path d="M12 3l2.9 5.88 6.5.95-4.7 4.58 1.11 6.47L12 17.77l-5.81 3.06L7.3 14.41 2.6 9.83l6.5-.95z" />,
  heart: <path d="M20.3 5.8a5 5 0 0 0-7.1 0L12 7l-1.2-1.2a5 5 0 1 0-7.1 7.1L12 21l8.3-8.1a5 5 0 0 0 0-7.1z" />,
  bookmark: <path d="M6 4.5h12a1 1 0 0 1 1 1v15l-7-4.2-7 4.2v-15a1 1 0 0 1 1-1z" />,
  users: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M2.5 20c0-3.1 2.9-5.1 6.5-5.1s6.5 2 6.5 5.1" />
      <path d="M16 5.2a3.2 3.2 0 0 1 0 6.1M17.5 14.4c2.4.5 4 2.2 4 4.6" />
    </>
  ),
  message: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10.6 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1.51 1 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
  bell: (
    <>
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </>
  ),
  pencil: <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />,
  chevronLeft: <path d="M15 18l-6-6 6-6" />,
  chevronRight: <path d="M9 18l6-6-6-6" />,
  chevronDown: <path d="M6 9.5l6 6 6-6" />,
  chevronUp: <path d="M6 14.5l6-6 6 6" />,
  chevronsLeft: <path d="M11 17l-5-5 5-5M18 17l-5-5 5-5" />,
  chevronsRight: <path d="M13 17l5-5-5-5M6 17l5-5-5-5" />,
  close: <path d="M18 6L6 18M6 6l12 12" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20.5 20.5L16 16" />
    </>
  ),
  check: <path d="M20 6.5L9 17.5l-5-5" />,
  checkSquare: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
      <path d="M8 12.5l2.8 2.8L16.5 9.5" />
    </>
  ),
  minus: <path d="M6.5 12h11" />,
  alert: (
    <>
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4.5M12 8h.01" />
    </>
  ),
  menu: <path d="M3.5 6.5h17M3.5 12h17M3.5 17.5h17" />,
  panel: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
      <path d="M9.5 3v18" />
    </>
  ),
  arrowRight: <path d="M5 12h13M13 6.5l5.5 5.5L13 17.5" />,
  arrowUp: <path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" />,
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  refresh: (
    <>
      <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" />
      <path d="M20.5 4v5h-5" />
    </>
  ),
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7.5 10.5l4.5 4.5 4.5-4.5M12 15V3.5" />
    </>
  ),
  trash: (
    <>
      <path d="M3.5 6.5h17" />
      <path d="M8.5 6.5V4.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v2" />
      <path d="M18.5 6.5l-1 14a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2l-1-14" />
    </>
  ),
  send: <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />,
  user: (
    <>
      <circle cx="12" cy="8" r="3.6" />
      <path d="M4.5 20.5c0-3.4 3.4-5.6 7.5-5.6s7.5 2.2 7.5 5.6" />
    </>
  ),
  logout: (
    <>
      <path d="M15 4.5h3a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-3" />
      <path d="M10 16.5L5.5 12 10 7.5" />
      <path d="M5.5 12H15" />
    </>
  ),
  lock: (
    <>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
      <path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" />
      <path d="M12 15v2" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M4 4l16 16" />
      <path d="M9.9 5.9A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.6 3.4" />
      <path d="M6.3 8.1A16.6 16.6 0 0 0 2.5 12S6 18.5 12 18.5a9.4 9.4 0 0 0 3.9-.9" />
      <path d="M10.3 10.5a2.8 2.8 0 0 0 3.5 3.9" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3l7 2.6v5.6c0 4.3-2.9 7.7-7 9.3-4.1-1.6-7-5-7-9.3V5.6z" />
      <path d="M9.2 12l2 2 3.6-4" />
    </>
  ),

  // —— 科研 / 学术主题图标：给技能库与画布节点用，语义比通用 UI 图标更贴切 ——
  compass: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M15.6 8.4l-2.2 5-5 2.2 2.2-5z" />
    </>
  ),
  map: (
    <>
      <path d="M3 6.5l6-2.5 6 2.5 6-2.5v13l-6 2.5-6-2.5-6 2.5z" />
      <path d="M9 4v13M15 6.5v13" />
    </>
  ),
  library: (
    <>
      <rect x="3.5" y="6" width="4" height="13" rx="1" />
      <rect x="9" y="4" width="4" height="15" rx="1" />
      <rect x="14.5" y="7.5" width="4" height="11.5" rx="1" />
      <path d="M2.5 20h19" />
    </>
  ),
  radar: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 12l6-6" />
      <circle cx="16.5" cy="8" r="1.1" />
    </>
  ),
  quill: (
    <>
      <path d="M20.5 3.5C12 3.5 6 8.5 6 15.5c0 2 .8 3.7 2 5" />
      <path d="M20.5 3.5c0 8.5-5.5 14-12.5 14" />
      <path d="M3 21l5.5-1.8" />
    </>
  ),
  gitBranch: (
    <>
      <circle cx="7" cy="5.5" r="2.2" />
      <circle cx="7" cy="18.5" r="2.2" />
      <circle cx="17" cy="8" r="2.2" />
      <path d="M7 7.7v8.6M17 10.2v1.3a4 4 0 0 1-4 4H9.2" />
    </>
  ),
  wand: (
    <>
      <path d="M4.5 19.5l11-11" />
      <path d="M15 4.5l.75 1.9 1.9.75-1.9.75-.75 1.9-.75-1.9-1.9-.75 1.9-.75z" />
      <path d="M19 13l.55 1.4 1.4.55-1.4.55-.55 1.4-.55-1.4-1.4-.55 1.4-.55z" />
    </>
  ),
  link: (
    <>
      <path d="M10 13.8a4.2 4.2 0 0 0 6 0l2.6-2.6a4.2 4.2 0 0 0-6-6l-1.5 1.5" />
      <path d="M14 10.2a4.2 4.2 0 0 0-6 0l-2.6 2.6a4.2 4.2 0 0 0 6 6l1.5-1.5" />
    </>
  ),
  quote: (
    <>
      <path d="M9.8 6.5C6.9 8 5.5 10.4 5.5 13.2V18h5v-5H8.2c0-2 .8-3.4 2.4-4.4z" />
      <path d="M19.3 6.5c-2.9 1.5-4.3 3.9-4.3 6.7V18h5v-5h-2.3c0-2 .8-3.4 2.4-4.4z" />
    </>
  ),
  chart: (
    <>
      <path d="M4 3.5v17h16" />
      <rect x="7" y="12" width="3.2" height="5.5" rx="0.8" />
      <rect x="12.4" y="8.5" width="3.2" height="9" rx="0.8" />
      <rect x="17.8" y="5.5" width="3.2" height="12" rx="0.8" />
    </>
  ),
  slides: (
    <>
      <rect x="3" y="4" width="18" height="12.5" rx="2" />
      <path d="M12 16.5V20M8.5 20h7" />
      <path d="M6.5 12.5l3.2-3.2 2.3 2.3 3-3.6 2.5 3" />
    </>
  ),
  clipboardCheck: (
    <>
      <rect x="5" y="4.5" width="14" height="16.5" rx="2" />
      <path d="M9 4.5V3.2A1.2 1.2 0 0 1 10.2 2h3.6A1.2 1.2 0 0 1 15 3.2v1.3" />
      <path d="M8.8 12.8l2.2 2.2 4.4-4.6" />
    </>
  ),
  copy: (
    <>
      <rect x="8.5" y="8.5" width="12" height="12" rx="2" />
      <path d="M15.5 8.5V6a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2.5" />
    </>
  ),
  reply: (
    <>
      <path d="M9 7L4 12l5 5" />
      <path d="M4 12h9.5a5.5 5.5 0 0 1 5.5 5.5V19" />
    </>
  ),
  scan: (
    <>
      <path d="M4 8.5V6a2 2 0 0 1 2-2h2.5M15.5 4H18a2 2 0 0 1 2 2v2.5M20 15.5V18a2 2 0 0 1-2 2h-2.5M8.5 20H6a2 2 0 0 1-2-2v-2.5" />
      <path d="M4 12h16" />
    </>
  ),
  /** 浏览器全屏的四角外扩 / 内收；画布专注模式专用 */
  maximize: (
    <>
      <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M3 16v3a2 2 0 0 0 2 2h3" />
    </>
  ),
  minimize: (
    <>
      <path d="M8 3v3a2 2 0 0 1-2 2H3M16 3v3a2 2 0 0 0 2 2h3M8 21v-3a2 2 0 0 0-2-2H3M16 21v-3a2 2 0 0 1 2-2h3" />
    </>
  ),
  pipeline: (
    <>
      <rect x="2" y="9" width="5.5" height="6" rx="1.5" />
      <rect x="9.25" y="9" width="5.5" height="6" rx="1.5" />
      <rect x="16.5" y="9" width="5.5" height="6" rx="1.5" />
      <path d="M7.5 12h1.75M14.75 12h1.75" />
    </>
  ),
  layers: (
    <>
      <path d="M12 3l9 4.8-9 4.8-9-4.8z" />
      <path d="M3 12l9 4.8 9-4.8" />
      <path d="M3 16.2l9 4.8 9-4.8" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <circle cx="8.5" cy="9.5" r="1.6" />
      <path d="M3 16.5l4.8-4.8 3.7 3.7 3.2-3.2 6.3 6.3" />
    </>
  ),
  notebook: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M9 3v18" />
      <path d="M12 8h4M12 12h4M12 16h3" />
    </>
  ),
  inbox: (
    <>
      <path d="M3 13h5l1.5 2.8h5L16 13h5" />
      <path d="M4.6 5h14.8L21 13v4.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V13z" />
    </>
  ),
  play: <path d="M8.5 6.2v11.6c0 .8.9 1.3 1.6.9l9.2-5.8c.6-.4.6-1.4 0-1.8l-9.2-5.8c-.7-.4-1.6.1-1.6.9z" />,
  code: (
    <>
      <path d="M8.5 8.5L4 12l4.5 3.5M15.5 8.5L20 12l-4.5 3.5" />
      <path d="M13.5 5.5l-3 13" />
    </>
  ),
  sigma: <path d="M17.5 5H8l5.2 7L8 19h9.5" />,
  bookOpen: (
    <>
      <path d="M12 6.5C10 5 7.5 4.5 4 4.5v14c3.5 0 6 .5 8 2 2-1.5 4.5-2 8-2v-14c-3.5 0-6 .5-8 2z" />
      <path d="M12 6.5v14" />
    </>
  ),
  lightbulb: (
    <>
      <path d="M9.5 18h5M10.5 21h3" />
      <path d="M12 3a6 6 0 0 0-3.6 10.8c.7.5 1.1 1.3 1.1 2.2h5c0-.9.4-1.7 1.1-2.2A6 6 0 0 0 12 3z" />
    </>
  ),
  network: (
    <>
      <circle cx="12" cy="5" r="2" />
      <circle cx="5" cy="18.5" r="2" />
      <circle cx="19" cy="18.5" r="2" />
      <path d="M12 7v4M10.8 12.8L6.2 16.8M13.2 12.8l4.6 4" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5.5" />
      <circle cx="12" cy="12" r="2" />
    </>
  ),
  apps: (
    <>
      <rect x="4" y="4" width="6" height="6" rx="1.5" />
      <rect x="14" y="4" width="6" height="6" rx="1.5" />
      <rect x="4" y="14" width="6" height="6" rx="1.5" />
      <circle cx="17" cy="17" r="3" />
    </>
  ),
  grid: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
  route: (
    <>
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="6" r="2" />
      <path d="M8 18h6a4 4 0 0 0 0-8h-4a4 4 0 0 1 0-8h6" />
    </>
  ),
  award: (
    <>
      <circle cx="12" cy="9" r="5.5" />
      <path d="M12 6.3l1 2 2.2.3-1.6 1.6.4 2.2-2-1.1-2 1.1.4-2.2-1.6-1.6 2.2-.3z" />
      <path d="M8.5 13.8L7 21l5-2.6 5 2.6-1.5-7.2" />
    </>
  ),
  /** 小树苗：关联图「起源圆」的标记；两片叶淡填充，茎与土线走描边 */
  sprout: (
    <>
      <path d="M12 20.5v-8.2" />
      <path
        d="M12 13.6C9.2 13.6 6.6 12 6.4 9.1c2.9-.3 5.1 1.1 5.6 4.5z"
        fill="currentColor"
        fillOpacity=".16"
      />
      <path
        d="M12 12.3c.2-3.4 2.2-5.7 5.6-6-.2 3-2.3 4.9-5.6 6z"
        fill="currentColor"
        fillOpacity=".16"
      />
      <path d="M8.7 20.5h6.6" />
    </>
  ),
  /** 对话框工具条：附件 / 文件夹 / 语音 / 由我批准 / 完全访问 / 模型 */
  paperclip: (
    <>
      <path d="M20.5 11.2l-8.4 8.4a5 5 0 0 1-7.1-7.1l8.5-8.5a3.4 3.4 0 0 1 4.8 4.8l-8.5 8.5a1.8 1.8 0 0 1-2.5-2.5l7.8-7.8" />
    </>
  ),
  folder: (
    <>
      <path d="M3 7.5A2 2 0 0 1 5 5.5h3.6l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="2.8" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" />
    </>
  ),
  hand: (
    <>
      <path d="M8 13.5V6.8a1.5 1.5 0 0 1 3 0v4.4" />
      <path d="M11 10.8V4.8a1.5 1.5 0 0 1 3 0v6" />
      <path d="M14 10.5V6.3a1.5 1.5 0 0 1 3 0v6.4" />
      <path d="M17 10a1.5 1.5 0 0 1 3 0v3.2c0 4.4-2.8 7.3-6.7 7.3h-1.1c-2.2 0-3.9-.9-5.1-2.6l-2.6-3.7a1.6 1.6 0 0 1 2.5-1.9L8 13.5" />
    </>
  ),
  bolt: (
    <>
      <path d="M13.2 2.5L4.5 13.8H11l-.7 7.7 8.9-11.6H12.5z" />
    </>
  ),
  cpu: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <rect x="9.2" y="9.2" width="5.6" height="5.6" rx="1" />
      <path d="M9 2.5v3.5M15 2.5v3.5M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5" />
    </>
  ),
  crown: (
    <>
      <path d="M3 7.5l3.6 3L12 5l5.4 5.5L21 7.5l-1.4 9.5H4.4z" />
      <path d="M6 21h12" />
    </>
  ),
}

/** 运行时校验：配置里存的图标名只要在图库里就认可，避免以后扩充图标时旧配置失效 */
export const isIconName = (v: unknown): v is IconName =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(P, v)

export function Icon({
  name,
  size = 14,
  className = '',
  strokeWidth = 1.8,
  ...rest
}: {
  name: IconName
  size?: number
  className?: string
  strokeWidth?: number
} & Omit<SVGProps<SVGSVGElement>, 'name' | 'width' | 'height'>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
      aria-hidden
      focusable="false"
      {...rest}
    >
      {P[name]}
    </svg>
  )
}
