/**
 * 浏览器端「数据库」—— 替代原后端的 SQLite。
 *
 * 原项目是 FastAPI + SQLite 单文件，数据主权是本产品的核心设计之一。
 * 搬到浏览器后存储层换成 localStorage，语义与 SQLite 侧保持一致：
 * 自增 id、DEFAULT 值、级联删除顺序、settings 键值表。
 *
 * 设计取舍：全部同步读写。localStorage 本身是同步 API，页面组件原有的
 * useApi/useAction 调用链不需要感知存储层，改动面最小。
 */

export type Row = Record<string, any>

/** 所有表名（与原 db.py 的 SCHEMA 一一对应） */
export const TABLES = [
  'ideas',
  'idea_reviews',
  'literature',
  'lit_notes',
  'lit_matrix',
  'experiments',
  'exp_results',
  'paper_stages',
  'paper_sections',
  'weekly_plans',
  'tasks',
  'daily_checkins',
  'advisor_notes',
  'points_ledger',
  'rewards',
  'llm_usage',
  'bets',
  'settings',
  'canvases',
  'canvas_nodes',
  'canvas_edges',
  'canvas_runs',
  'canvas_node_outputs',
  'chat_sessions',
  'chat_messages',
] as const

export type TableName = (typeof TABLES)[number]

/** 建表默认值，等价于原 DDL 里的 DEFAULT 子句 */
const DEFAULTS: Partial<Record<TableName, Row>> = {
  ideas: { novelty: 3, feasibility: 3, impact: 3, effort: 3, status: 'captured' },
  literature: { status: 'todo', rating: 3 },
  lit_notes: { sort_order: 0, source: 'ai' },
  lit_matrix: { sort_order: 0 },
  experiments: { status: 'planned' },
  exp_results: { success: 0 },
  paper_stages: { sort_order: 0, status: 'todo' },
  paper_sections: { sort_order: 0, word_count: 0, target_words: 0, status: 'todo' },
  weekly_plans: { status: 'active' },
  tasks: { status: 'todo', points: 10 },
  advisor_notes: { status: 'open' },
  rewards: { redeemed_count: 0 },
  llm_usage: { tokens_in: 0, tokens_out: 0 },
  bets: { amount: 100, status: 'open' },
  canvases: {},
  canvas_nodes: { type: 'skill', x: 0, y: 0 },
  canvas_edges: {},
  canvas_runs: { status: 'running' },
  canvas_node_outputs: { tokens_in: 0, tokens_out: 0, elapsed_ms: 0, status: 'done' },
  chat_sessions: { title: '新对话', role: 'assistant', mode: 'fast', context: '' },
  chat_messages: { tokens_in: 0, tokens_out: 0 },
}

/** 自动维护 updated_at 的表（对应原 TABLES_WITH_UPDATED_AT） */
export const TABLES_WITH_UPDATED_AT = new Set<TableName>([
  'ideas',
  'literature',
  'lit_notes',
  'experiments',
  'paper_stages',
  'paper_sections',
  'canvases',
])

const PREFIX = 'wb-db:'
const META_KEY = '@@meta'

/** 与后端 now() 对齐：本地时间 ISO 秒级，无时区后缀 */
export function now(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  )
}

/** 与后端 date.today() 对齐 */
export function today(): string {
  return now().slice(0, 10)
}

/** 今天往前 n 天的日期（YYYY-MM-DD） */
export function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 本周一（对应后端 _week_start：weekday() 起点） */
export function weekStart(d = today()): string {
  const dt = new Date(d + 'T00:00:00')
  const dow = (dt.getDay() + 6) % 7 // 周一=0
  dt.setDate(dt.getDate() - dow)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`
}

type DbShape = Record<string, Row[]> & { [META_KEY]?: { nextId: Record<string, number> } }

let cache: DbShape | null = null

function emptyDb(): DbShape {
  const db: DbShape = { [META_KEY]: { nextId: {} } } as DbShape
  for (const t of TABLES) db[t] = []
  return db
}

function readStorage(): DbShape {
  if (cache) return cache
  try {
    const raw = localStorage.getItem(PREFIX + 'data')
    if (raw) {
      const parsed = JSON.parse(raw)
      const db = emptyDb()
      for (const t of TABLES) if (Array.isArray(parsed[t])) db[t] = parsed[t]
      db[META_KEY] = parsed[META_KEY] || { nextId: {} }
      cache = db
      return db
    }
  } catch {
    /* 解析失败就当空库重建 */
  }
  cache = emptyDb()
  return cache
}

function persist() {
  if (!cache) return
  try {
    localStorage.setItem(PREFIX + 'data', JSON.stringify(cache))
  } catch {
    /* 容量超限时忽略，不阻塞业务 */
  }
}

/** 清空整个库（演示数据重置用） */
export function resetDb() {
  cache = emptyDb()
  persist()
}

/** 库是否为空（判断要不要灌种子） */
export function isEmptyDb(): boolean {
  const db = readStorage()
  return (db.canvases?.length ?? 0) === 0 && (db.paper_stages?.length ?? 0) === 0
}

function nextId(table: string): number {
  const db = readStorage()
  const meta = db[META_KEY]!
  let max = meta.nextId[table] ?? 0
  for (const r of db[table] ?? []) if (typeof r.id === 'number' && r.id > max) max = r.id
  max += 1
  meta.nextId[table] = max
  return max
}

export const db = {
  /** 全表读取（按插入顺序，等价 SQLite 无 ORDER BY 的 rowid 顺序） */
  all(table: TableName): Row[] {
    return [...(readStorage()[table] ?? [])]
  },

  find(table: TableName, pred: (r: Row) => boolean): Row[] {
    return (readStorage()[table] ?? []).filter(pred)
  },

  first(table: TableName, pred: (r: Row) => boolean): Row | null {
    return (readStorage()[table] ?? []).find(pred) ?? null
  },

  get(table: TableName, id: number | string | null | undefined): Row | null {
    if (id == null) return null
    const n = Number(id)
    return (readStorage()[table] ?? []).find((r) => r.id === n) ?? null
  },

  insert(table: TableName, row: Row): Row {
    const store = readStorage()
    const rec: Row = { ...(DEFAULTS[table] ?? {}), ...row }
    rec.id = nextId(table)
    if (TABLES_WITH_UPDATED_AT.has(table) && rec.updated_at === undefined) {
      rec.updated_at = now()
    }
    const arr = store[table] ?? (store[table] = [])
    arr.push(rec)
    persist()
    return { ...rec }
  },

  update(table: TableName, id: number | string, patch: Row): Row | null {
    const store = readStorage()
    const n = Number(id)
    const rec = (store[table] ?? []).find((r) => r.id === n)
    if (!rec) return null
    Object.assign(rec, patch)
    if (TABLES_WITH_UPDATED_AT.has(table) && patch.updated_at === undefined) {
      rec.updated_at = now()
    }
    persist()
    return { ...rec }
  },

  remove(table: TableName, id: number | string): boolean {
    const store = readStorage()
    const n = Number(id)
    const arr = store[table] ?? []
    const i = arr.findIndex((r) => r.id === n)
    if (i < 0) return false
    arr.splice(i, 1)
    persist()
    return true
  },

  /** 批量删除，返回实际删除条数 */
  removeWhere(table: TableName, pred: (r: Row) => boolean): number {
    const store = readStorage()
    const arr = store[table] ?? []
    let n = 0
    for (let i = arr.length - 1; i >= 0; i--) {
      if (pred(arr[i])) {
        arr.splice(i, 1)
        n++
      }
    }
    persist()
    return n
  },

  // ---- settings 键值表 ----
  setting(key: string): string | null {
    const rec = (readStorage().settings ?? []).find((r) => r.key === key)
    return rec ? (rec.value as string) : null
  },

  setSetting(key: string, value: string) {
    const store = readStorage()
    const arr = store.settings ?? (store.settings = [])
    const rec = arr.find((r) => r.key === key)
    if (rec) rec.value = value
    else arr.push({ id: nextId('settings'), key, value })
    persist()
  },

  settingJson<T>(key: string, fallback: T): T {
    const raw = db.setting(key)
    if (!raw) return fallback
    try {
      return JSON.parse(raw) as T
    } catch {
      return fallback
    }
  },

  setSettingJson(key: string, value: unknown) {
    db.setSetting(key, JSON.stringify(value))
  },
}

export default db
