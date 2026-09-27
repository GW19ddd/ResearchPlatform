import { ReactNode } from 'react'
import { Btn, Details } from './ui'

/**
 * AI 调用结果的展示层。
 *
 * 后端对所有 LLM 调用统一返回信封：
 *   { ok: true,  result: "...", provider, model, tokens_in, tokens_out, error: null }
 *   { ok: false, result: "",    error: { kind, label, message, detail, hint } }
 *
 * 这里只负责把它画出来。三条硬规则：
 *   1. 失败**不渲染** result —— 空的正文不能当成模型产出给用户看
 *   2. 失败必须给出可行动的原因（hint），而不是把异常类名甩给用户
 *   3. 技术细节（detail）默认收起，且永远不会包含密钥（后端已脱敏）
 */
export type AiErrorInfo = {
  kind?: string
  label?: string
  message?: string
  detail?: string
  hint?: string
}

export type AiEnvelope = {
  ok?: boolean
  result?: string
  error?: AiErrorInfo | null
  provider?: string
  model?: string
  tokens_in?: number
  tokens_out?: number
}

export function isAiFailure(res: unknown): res is { error: AiErrorInfo } {
  const r = res as AiEnvelope | null
  return !!r && r.ok === false
}

/** 统一信封 → 错误对象。兼容后端直接抛 HTTPException 的旧路径（那时只有 message）。 */
export function aiErrorOf(res: unknown, fallbackMessage?: string): AiErrorInfo {
  const r = (res || {}) as AiEnvelope
  if (r.error) return r.error
  return {
    kind: 'http_error',
    label: '请求失败',
    message: (r as any)?.message || fallbackMessage || '调用没有返回结果',
    detail: '',
    hint: '确认后端服务在运行后重试。',
  }
}

export function AiError({
  error,
  onRetry,
  retrying,
  title,
  extra,
}: {
  error: AiErrorInfo
  onRetry?: () => void
  retrying?: boolean
  title?: ReactNode
  extra?: ReactNode
}) {
  const detail = (error.detail || '').trim()
  return (
    <div className="rounded-[12px] border border-[color:var(--wb-danger)]/30 bg-[color:var(--wb-danger-soft)] px-3.5 py-3">
      <div className="flex items-start gap-2">
        <span aria-hidden className="mt-[1px] text-[13px] text-[color:var(--wb-danger)]">
          ✕
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-medium text-[color:var(--wb-danger)]">
            {title || error.label || '调用失败'}
          </div>
          <div className="mt-0.5 break-words text-[12px] text-[color:var(--wb-text)]">
            {error.message || '没有拿到可用的结果'}
          </div>
          {error.hint && (
            <div className="mt-1 break-words text-[11.5px] text-[color:var(--wb-text-soft)]">
              {error.hint}
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {onRetry && (
              <Btn size="sm" variant="danger" onClick={onRetry} loading={retrying}>
                重试
              </Btn>
            )}
            {extra}
          </div>
          {detail && (
            <Details summary="技术详情" className="mt-2 bg-[color:var(--wb-surface)]">
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-[1.6]">
                {detail}
              </pre>
            </Details>
          )}
        </div>
      </div>
      <div className="mt-2 border-t border-[color:var(--wb-danger)]/20 pt-1.5 text-[11px] text-[color:var(--wb-muted)]">
        失败不会写入你的研究数据，输入内容原样保留。
      </div>
    </div>
  )
}

/** 成功时的轻提示条：谁跑的、花了多少 token。技术信息，默认一行。 */
export function AiMeta({ res }: { res: AiEnvelope }) {
  if (res.ok === false) return null
  const bits = [
    res.provider,
    res.model,
    res.tokens_in || res.tokens_out
      ? `${res.tokens_in || 0} in / ${res.tokens_out || 0} out`
      : '',
  ].filter(Boolean)
  if (!bits.length) return null
  return (
    <div className="mt-1.5 text-[11px] text-[color:var(--wb-muted)]">{bits.join(' · ')}</div>
  )
}
