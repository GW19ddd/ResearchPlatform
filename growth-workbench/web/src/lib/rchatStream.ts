/**
 * 研究对话的 SSE 流式请求。
 *
 * 后端 /rchat/sessions/{sid}/chat/stream 推送的是「真实阶段」事件（不是前端假动画）：
 *   stage  —— 生成检索式 / OpenAlex 检索 / 去重入库 / 撰写综述，带真实进度与命中数
 *   papers —— 本次检索命中的文献行（供对话栏里的「文献检索」常驻卡）
 *   done   —— 已经落库的最终 assistant 消息（前端直接拿它替换乐观消息）
 *   error  —— 失败原因
 *
 * 刻意不用 api.ts 的 post()：
 *   1) 流式请求绝不能带 Idempotency-Key，幂等中间件会把整条流读进内存再回放；
 *   2) 需要 ReadableStream 逐块解析，parseSse 负责处理被网络分块切断的事件。
 */
import { parseSse, type SseEvent } from './sse'

export type PaperHit = {
  n: number
  lit_id?: number
  openalex_id?: string
  title?: string
  authors?: string
  year?: number | null
  venue?: string
  doi?: string
  url?: string
  cited_by_count?: number
  cit_per_year?: number
  language?: string
  match?: number
  pdf_url?: string
  is_oa?: boolean
  /** OpenAlex abstract_inverted_index 还原出的真实摘要；接口未返回则为空串（不编造） */
  abstract?: string
}

export type StageEv = {
  type: 'stage'
  key: string
  label: string
  pct: number
  detail?: string
  count?: number | null
  unit?: string
  /** true = LLM 长调用期间按真实耗时推的心跳，不是任务完成度 */
  estimated?: boolean
}

export type PapersEv = {
  type: 'papers'
  papers: PaperHit[]
  total: number
  query_count: number
  raw_hits: number
}

export type RchatServerMsg = {
  id: number
  session_id: number
  role: 'user' | 'assistant'
  kind: string
  content: string
  meta: any
  elapsed_ms?: number
  provider?: string
  model?: string
  created_at?: string
}

export type DoneEv = { type: 'done'; message: RchatServerMsg }
export type ErrorEv = { type: 'error'; message: string }
export type ChatStreamEvent = StageEv | PapersEv | DoneEv | ErrorEv

function errText(raw: string, status: number): string {
  let msg = (raw || '').trim()
  if (!msg) return `请求失败（HTTP ${status}）`
  try {
    const j = JSON.parse(msg)
    if (j && typeof j.detail === 'string') msg = j.detail
    else if (j && typeof j.message === 'string') msg = j.message
  } catch {
    /* 纯文本直接用 */
  }
  return msg.length > 140 ? msg.slice(0, 140) + '…' : msg
}

/**
 * 发一条流式对话。返回最终落库的 assistant 消息；失败抛 Error（文案已是人话）。
 * onEvent 会按后端真实顺序收到每一条事件。
 */
export async function streamChat(
  sid: number,
  body: {
    instruction: string
    mode: 'auto' | 'deep' | 'report' | 'review'
    tag?: string
    /** 对话框偏好（审批模式 / 本轮模型 / 工作区与附件），由 chatEnvelope() 注入 */
    [k: string]: unknown
  },
  onEvent: (ev: ChatStreamEvent) => void,
  /** 删除会话时由 ConvoStore.removeSession 触发 abort，在途 SSE 立刻断开 */
  signal?: AbortSignal,
): Promise<RchatServerMsg> {
  const res = await fetch(`/api/rchat/sessions/${sid}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // 不带 Idempotency-Key：见文件头注释
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event('wb:unauthorized'))
    const t = await res.text().catch(() => '')
    throw new Error(errText(t, res.status))
  }
  if (!res.body) throw new Error('后端未返回流式响应')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let final: RchatServerMsg | null = null
  let failure = ''

  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const { events, rest } = parseSse(buf)
    buf = rest
    for (const raw of events as SseEvent[]) {
      const ev = raw as unknown as ChatStreamEvent
      onEvent(ev)
      if (ev.type === 'done') final = ev.message
      else if (ev.type === 'error') failure = ev.message || '调研失败'
    }
    if (failure) break
  }

  if (failure) throw new Error(failure)
  if (!final) throw new Error('流已结束，但没有收到完成事件')
  return final
}
