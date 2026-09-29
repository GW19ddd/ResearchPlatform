/**
 * 外部服务依赖功能的浏览器端降级实现。
 *
 * 原 FastAPI 后端里有几类能力是「服务端专属」的：
 * - Gloss：启动本地 Python 进程、操作本地 PDF 目录；
 * - Zotero：服务端直连 Zotero Web API（不受浏览器跨域限制）；
 * - 备份：读写本地 SQLite 文件、做完整性校验；
 * - AI 疑似内容扫描：扫全库文本并做规则匹配。
 *
 * 搬到浏览器后这些能力**全部不可真实实现**：没有进程、没有文件系统、跨域被拦截、
 * 存储换成了 localStorage。因此这里的原则是「优雅降级」：
 *   **保留接口形状，返回结构正确但内容为空 / 带提示的对象，绝对不抛错。**
 * 这样页面上的相关卡片只会显示「浏览器环境不支持」，而不会因为 404/异常整页崩溃。
 * 这不是漏做，是有意为之——见各接口上方注释。
 */
import { route } from './core'

// ---------------------------------------------------------------------------
// Gloss（本地 PDF 阅读器 / 旁注服务）
// ---------------------------------------------------------------------------

/**
 * Gloss 状态对象的唯一构造入口。
 * 返回新对象而非共享常量，避免调用方改动字段后污染其它请求的返回值。
 */
function glossStatus() {
  return {
    dir: '',
    port: 0,
    url: '',
    installed: false,
    running: false,
    python: '',
    pdf_dirs: [] as string[],
  }
}

// 原为服务端能力（探测并控制本地 Gloss 进程），浏览器端不可用，保留接口形状以免页面报错
route('GET', '/gloss/status', () => glossStatus())

// 原为服务端能力（spawn 本地进程），浏览器端无法启动，返回失败信封让前端提示用户
route('POST', '/gloss/start', () => ({
  ok: false,
  started: false,
  message: '浏览器环境不支持启动本地 Gloss 服务',
}))

// 原为服务端能力（写入配置文件），浏览器端无文件系统；回显一份默认状态，让表单不出错
route('PUT', '/gloss/config', () => glossStatus())

// 原为服务端能力（扫描本地目录匹配 PDF），浏览器端无文件系统，返回空候选
route('GET', '/gloss/find', () => ({ candidates: [] as unknown[], dirs: [] as string[] }))

// 原为服务端能力（读取本地 PDF 与 Gloss 馆藏），浏览器端不可用，返回空信息
route('GET', '/literature/:id/pdf-info', () => ({
  ok: false,
  source: 'none',
  path: '',
  gloss_id: '',
  gloss_running: false,
  candidates: [] as unknown[],
  dirs: [] as string[],
}))

// 原为服务端能力（调用 localhost 打开外部阅读器），浏览器端无法唤起，返回失败提示
route('POST', '/literature/:id/gloss', () => ({
  ok: false,
  message: '浏览器环境无法打开本地 PDF 阅读器',
}))

// ---------------------------------------------------------------------------
// 备份（原为本地 SQLite 快照）
// ---------------------------------------------------------------------------

// 原为服务端能力（列本地备份目录），浏览器端无备份文件，返回空列表
route('GET', '/backup', () => [])

// 原为服务端能力（复制 SQLite 文件做快照），浏览器端数据本就在 localStorage，无需备份
route('POST', '/backup/create', () => ({
  ok: false,
  message: '浏览器环境使用 localStorage 存储，无需手动备份',
}))

// 原为服务端能力（校验备份文件完整性），浏览器端无备份文件
route('GET', '/backup/:name/verify', () => ({ ok: false, message: '无备份文件' }))

// 原为服务端能力（从备份文件覆盖恢复），浏览器端无备份文件
route('POST', '/backup/:name/restore', () => ({ ok: false, message: '无备份文件' }))

// 删除是无害的幂等操作：本来就没有文件，直接返回成功，避免前端弹「删除失败」
route('DELETE', '/backup/:name', () => ({ ok: true }))

// ---------------------------------------------------------------------------
// Zotero（原由服务端转发，绕开浏览器跨域）
// ---------------------------------------------------------------------------

// 原为服务端能力（读取 Zotero 配置），浏览器端未启用，返回禁用态
route('GET', '/zotero/config', () => ({
  enabled: false,
  api_key_set: false,
  user_id: '',
  collections: [] as unknown[],
}))

// 原为服务端能力（探测 Zotero 连通性），浏览器直连会被 CORS 拦截，返回失败提示
route('POST', '/zotero/probe', () => ({
  ok: false,
  message: '浏览器环境无法直连 Zotero（跨域限制）',
}))

// 原为服务端能力（同步 Zotero 文献），浏览器直连会被 CORS 拦截，返回失败提示
route('POST', '/zotero/sync', () => ({
  ok: false,
  message: '浏览器环境无法直连 Zotero（跨域限制）',
}))

// 原为服务端能力（拉取 Zotero 收藏夹），浏览器端返回空列表
route('GET', '/zotero/library/collections', () => [])

// 原为服务端能力（从 Zotero 导入条目），浏览器端无法导入，返回 imported: 0
route('POST', '/zotero/import', () => ({
  ok: false,
  imported: 0,
  message: '浏览器环境无法直连 Zotero',
}))

// 原为服务端能力（在 Zotero 建收藏夹），浏览器端不可用
route('POST', '/zotero/collections', () => ({
  ok: false,
  message: '浏览器环境无法直连 Zotero',
}))

// ---------------------------------------------------------------------------
// AI 疑似内容扫描（原由服务端扫全库文本）
// ---------------------------------------------------------------------------

// 原为服务端能力（扫描疑似 AI 编造内容），浏览器端无对应数据源，返回空列表
route('GET', '/ai/suspects', () => [])

// 原为服务端能力（清理疑似记录），浏览器端没有可清理的数据，返回 cleaned: 0
route('POST', '/ai/suspects/cleanup', () => ({ ok: true, cleaned: 0 }))
