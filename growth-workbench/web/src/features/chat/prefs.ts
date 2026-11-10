/**
 * 对话框偏好：审批模式 / 本轮模型 / 工作区上下文 / 附件。
 *
 * 一处状态，/chat 工作台与共用 ChatPanel（研究对话、画布、实验 Agent）共享。
 * 除附件正文外都持久化到 localStorage；附件是「本轮上下文」，刷新不复活，
 * 也不写进 localStorage（正文可能几十 KB，容易撑爆配额）。
 *
 * 发送点统一 `...chatEnvelope()`，后端据此把偏好注入 system / 覆盖本轮模型名。
 */
import { useSyncExternalStore } from 'react'

export type ApprovalMode = 'ask' | 'full'
export type ChatAttachment = { name: string; size: number; text?: string }

export type ChatPrefs = {
  /** ask=由我批准（危险操作先问）；full=完全访问 */
  approval: ApprovalMode
  /** '' = 跟随全局设置（llm.py 统一 fast 档） */
  model: string
  workspace: string
  branch: string
  worktree: boolean
  attachments: ChatAttachment[]
  /** 文件夹选择器带进来的相对路径，只作为文件树上下文，不读正文 */
  workspaceFiles: string[]
}

const KEY = 'wb:chat.prefs'

/** 默认值取真实工作区/分支（见 git rev-parse），不是编出来的占位符 */
const DEFAULT: ChatPrefs = {
  approval: 'ask',
  model: '',
  workspace: 'ResearchPlatform',
  branch: 'nuwax-port',
  worktree: false,
  attachments: [],
  workspaceFiles: [],
}

function load(): ChatPrefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULT }
    const v = JSON.parse(raw) as Partial<ChatPrefs>
    return {
      ...DEFAULT,
      ...v,
      approval: v.approval === 'full' ? 'full' : 'ask',
      attachments: [],
      workspaceFiles: [],
    }
  } catch {
    return { ...DEFAULT }
  }
}

let current: ChatPrefs = load()
const listeners = new Set<() => void>()

function emit(next: ChatPrefs) {
  current = next
  try {
    // 附件与文件树只在内存里，不落盘
    const { attachments: _a, workspaceFiles: _f, ...rest } = next
    localStorage.setItem(KEY, JSON.stringify(rest))
  } catch {
    /* 容量超限时忽略 */
  }
  listeners.forEach((fn) => fn())
}

export function getPrefs(): ChatPrefs {
  return current
}

export function setPrefs(patch: Partial<ChatPrefs>) {
  emit({ ...current, ...patch })
}

export function useChatPrefs(): ChatPrefs {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => current,
    () => DEFAULT,
  )
}

/** 每个聊天入口发请求时 spread 进 body */
export function chatEnvelope() {
  const p = getPrefs()
  return {
    approval_mode: p.approval,
    model: p.model,
    workspace: { name: p.workspace.trim(), branch: p.branch.trim(), worktree: p.worktree },
    attachments: p.attachments.map((a) => ({ name: a.name, size: a.size, text: a.text || '' })),
    workspace_files: p.workspaceFiles,
  }
}

const TEXT_EXT =
  /\.(txt|md|markdown|csv|tsv|json|jsonl|yaml|yml|py|ts|tsx|js|jsx|java|c|cc|cpp|h|hpp|go|rs|sh|bib|ris|tex|log|ini|toml|xml|html|css|sql|r|ipynb)$/i
const MAX_PER_FILE = 6000
const MAX_TOTAL_TEXT = 24000

/** 选择文件（或文件夹）后挂到输入框上方，作为本轮上下文随请求发给后端 */
export async function addFiles(list: FileList | File[], asDir = false) {
  const arr = Array.from(list)
  if (asDir) {
    const names = arr.slice(0, 60).map((f) => (f as any).webkitRelativePath || f.name)
    setPrefs({ workspaceFiles: [...current.workspaceFiles, ...names].slice(0, 60) })
    return
  }
  let budget = Math.max(
    0,
    MAX_TOTAL_TEXT - current.attachments.reduce((s, a) => s + (a.text?.length || 0), 0),
  )
  const next: ChatAttachment[] = []
  for (const f of arr.slice(0, 8)) {
    let text = ''
    // 二进制文件只带文件名与大小，不把乱码塞进 prompt
    if (TEXT_EXT.test(f.name) && budget > 0) {
      try {
        text = (await f.text()).slice(0, Math.min(MAX_PER_FILE, budget))
      } catch {
        text = ''
      }
    }
    budget -= text.length
    next.push({ name: f.name, size: f.size, text })
  }
  setPrefs({ attachments: [...current.attachments, ...next].slice(0, 12) })
}

export function removeAttachment(index: number) {
  setPrefs({ attachments: current.attachments.filter((_, i) => i !== index) })
}

export function removeWorkspaceFile(index: number) {
  setPrefs({ workspaceFiles: current.workspaceFiles.filter((_, i) => i !== index) })
}
