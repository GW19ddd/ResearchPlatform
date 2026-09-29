/**
 * 右侧节点检视面板：改配置、单跑节点、看输出与运行记录。
 *
 * 从 pages/Canvas.tsx 抽出来的一块内聚逻辑 —— 页面只负责「选中了哪个节点」，
 * 面板自己按节点类型决定显示哪些字段。新增节点类型只需要改这里 + canvas-shared。
 */
import type { ReactNode } from 'react'
import { Btn, Input, MdBlock, Pill, Select, TextArea } from '../../components/ui'
import { AiError } from '../../components/AiError'
import { PROMPT_HINT, TYPE_LABEL, type CData, type CNode, type Skill } from './canvas-shared'

export type RunInfo = {
  id: number
  scope: string
  status: string
  started_at: string
  finished_at?: string | null
  out_count?: number
}

/** 输出可以落到哪个模块：创新点 / 文献 / 论文阶段 */
export type OutputTarget = 'idea' | 'literature' | 'paper'

const FieldLabel = ({ children, hint }: { children: ReactNode; hint?: string }) => (
  <div className="mb-1 flex items-baseline gap-1.5">
    <span className="text-[11.5px] font-medium text-[color:var(--wb-text-soft)]">{children}</span>
    {hint && <span className="text-[11.5px] text-[color:var(--wb-muted)]">{hint}</span>}
  </div>
)

export default function NodeInspector({
  node,
  skills,
  providers,
  difyApps,
  difyBase,
  difyEnabled,
  output,
  meta,
  running,
  runs,
  error,
  onPatch,
  onRun,
  onDelete,
  onSaveOutput,
  onOpenSource,
  onExpandOutput,
}: {
  node: CNode | null
  skills: Skill[]
  providers: { id: string; name: string }[]
  difyApps: any[]
  difyBase: string
  difyEnabled: boolean
  output: string
  meta: any
  running: boolean
  runs: RunInfo[]
  /** 本次运行中这个节点的错误（后端信封），有就优先显示，不拿空输出冒充成果 */
  error?: any | null
  onPatch: (fn: (d: CData) => CData) => void
  onRun: () => void
  onDelete: () => void
  onSaveOutput: (target: OutputTarget) => void
  onOpenSource: (id: string, name: string) => void
  onExpandOutput?: () => void
}) {
  if (!node) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <div className="text-[13px] text-[color:var(--wb-text-soft)]">选中一个节点</div>
        <p className="text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
          左侧拖技能进画布，或点「+ 自定义」写自己的指令。
          <br />
          连线表示数据流向：上游输出会作为 {'{{upstream}}'} 注入下游。
        </p>
      </div>
    )
  }

  const d = node.data
  const skill = skills.find((s) => s.id === d.skillId)
  const set = (fn: (v: CData) => CData) => onPatch(fn)
  const setCfg = (patch: Record<string, any>) => set((v) => ({ ...v, config: { ...v.config, ...patch } }))

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 头部：标题 + 身份信息 */}
      <div className="shrink-0 border-b border-[color:var(--wb-border)] px-3 py-2.5">
        <Input
          value={d.title}
          onChange={(v) => set((x) => ({ ...x, title: v }))}
          placeholder="节点标题"
        />
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10.5px] text-[color:var(--wb-muted)]">
          <Pill tone={d.ntype === 'prompt' ? 'indigo' : 'gray'}>{TYPE_LABEL[d.ntype]}</Pill>
          <span className="tabular-nums">{node.id}</span>
          {meta?.model && <span className="truncate">· {meta.model}</span>}
          {meta?.elapsed_ms ? <span>· {(meta.elapsed_ms / 1000).toFixed(1)}s</span> : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {/* ---------------- 配置 ---------------- */}
        {d.ntype === 'skill' && (
          <>
            <div className="mb-3">
              <FieldLabel>技能</FieldLabel>
              <Select
                value={d.skillId}
                onChange={(v) => set((x) => ({ ...x, skillId: v, title: v ? x.title : x.title }))}
                options={[
                  { value: '', label: '选择技能…' },
                  ...skills.map((s) => ({ value: s.id, label: s.name })),
                ]}
              />
              {skill?.desc && (
                <div className="mt-1 text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
                  {skill.desc}
                </div>
              )}
              {skill?.source === 'github' && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <Pill tone="green">GitHub 原版 · {skill.category}</Pill>
                  <Btn size="sm" onClick={() => onOpenSource(skill.id, skill.name)}>
                    看 SKILL.md 原文
                  </Btn>
                </div>
              )}
            </div>

            {(skill?.inputs || []).map((inp) => (
              <div key={inp.key} className="mb-3">
                <FieldLabel>{inp.label}</FieldLabel>
                <TextArea
                  rows={3}
                  value={(d.config.inputs || {})[inp.key] || ''}
                  placeholder={inp.placeholder}
                  onChange={(v) =>
                    setCfg({ inputs: { ...(d.config.inputs || {}), [inp.key]: v } })
                  }
                />
              </div>
            ))}

            <div className="mb-3">
              <FieldLabel hint="{{input}}">直接补充要求</FieldLabel>
              <TextArea
                rows={2}
                value={d.config.text || ''}
                onChange={(v) => setCfg({ text: v })}
              />
            </div>
          </>
        )}

        {d.ntype === 'prompt' && (
          <>
            <div className="mb-3">
              <FieldLabel hint="写清角色与口径，留空用默认科研助手">system</FieldLabel>
              <TextArea
                rows={3}
                value={d.config.system || ''}
                placeholder="例：你是一位严格的系统会议审稿人，只输出结构化结论。"
                onChange={(v) => setCfg({ system: v })}
              />
            </div>
            <div className="mb-3">
              <FieldLabel>指令</FieldLabel>
              <TextArea
                rows={8}
                value={d.config.prompt || ''}
                placeholder={'例：把下面的进展整理成 3 条可汇报结论：\n\n{{upstream}}'}
                onChange={(v) => setCfg({ prompt: v })}
              />
              <div className="mt-1 text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
                {PROMPT_HINT}
              </div>
            </div>
            <div className="mb-3">
              <FieldLabel hint="{{input}}">直接补充要求</FieldLabel>
              <TextArea rows={2} value={d.config.text || ''} onChange={(v) => setCfg({ text: v })} />
            </div>
          </>
        )}

        {d.ntype === 'input' && (
          <div className="mb-3">
            <FieldLabel hint="原样传给下游">输入文本</FieldLabel>
            <TextArea
              rows={8}
              value={d.config.text || ''}
              onChange={(v) => setCfg({ text: v })}
              placeholder="研究方向、草稿、审稿意见…"
            />
          </div>
        )}

        {d.ntype === 'output' && (
          <div className="mb-3">
            <FieldLabel>前缀（可选）</FieldLabel>
            <TextArea
              rows={2}
              value={d.config.prefix || ''}
              onChange={(v) => setCfg({ prefix: v })}
            />
          </div>
        )}

        {d.ntype === 'tool' && (
          <>
            <div className="mb-3">
              <FieldLabel>工具类型</FieldLabel>
              <Select
                value={d.config.tool || 'dify'}
                onChange={(v) => setCfg({ tool: v })}
                options={[
                  { value: 'dify', label: 'Dify workflow' },
                  { value: 'http', label: 'HTTP 请求' },
                ]}
              />
            </div>
            {d.config.tool === 'http' ? (
              <>
                <div className="mb-3">
                  <FieldLabel>URL</FieldLabel>
                  <Input
                    value={d.config.url || ''}
                    onChange={(v) => setCfg({ url: v })}
                    placeholder="https://..."
                  />
                </div>
                <div className="mb-3">
                  <FieldLabel hint="{{upstream}}">请求体 JSON</FieldLabel>
                  <TextArea
                    rows={4}
                    value={d.config.body || ''}
                    onChange={(v) => setCfg({ body: v })}
                    placeholder='{"query":"{{upstream}}"}'
                  />
                </div>
              </>
            ) : (
              <>
                <div className="mb-3">
                  <FieldLabel>选择 Dify 应用</FieldLabel>
                  <Select
                    value={d.config.app_id || ''}
                    onChange={(v) => setCfg({ app_id: v })}
                    options={[
                      {
                        value: '',
                        label: difyApps.length ? '默认（列表第一个）' : '设置页还没配置应用',
                      },
                      ...difyApps.map((a: any) => ({
                        value: a.id,
                        label: `${a.name} · ${a.mode === 'chat' ? '对话' : '工作流'}`,
                      })),
                    ]}
                  />
                  <div className="mt-1 text-[10.5px] leading-relaxed text-[color:var(--wb-muted)]">
                    地址与 API Key 在
                    <a href="/settings" className="mx-1 text-[color:var(--wb-accent)] underline">
                      设置页
                    </a>
                    的 Dify 卡片里填：{difyBase || '（未填）'}
                    {difyEnabled ? ' · 已启用' : ' · 未启用'}
                  </div>
                </div>
                <div className="mb-3">
                  <FieldLabel hint="{{upstream}}">inputs（JSON）</FieldLabel>
                  <TextArea
                    rows={4}
                    value={
                      typeof d.config.inputs === 'string'
                        ? d.config.inputs
                        : JSON.stringify(d.config.inputs || {}, null, 2)
                    }
                    onChange={(v) => setCfg({ inputs: v })}
                    placeholder='{"query":"{{upstream}}"}'
                  />
                </div>
                <div className="mb-3">
                  <FieldLabel>调用方式</FieldLabel>
                  <Select
                    value={d.config.dify_mode || ''}
                    onChange={(v) => setCfg({ dify_mode: v })}
                    options={[
                      { value: '', label: '跟随应用设置' },
                      { value: 'workflow', label: 'workflows/run' },
                      { value: 'chat', label: 'chat-messages' },
                    ]}
                  />
                </div>
              </>
            )}
          </>
        )}

        {/* ---------------- 模型参数（两种 LLM 节点共用） ---------------- */}
        {(d.ntype === 'skill' || d.ntype === 'prompt') && (
          <div className="mb-3 grid grid-cols-2 gap-2">
            <div>
              <FieldLabel>模式</FieldLabel>
              <Select
                value={d.config.mode || skill?.mode || 'fast'}
                onChange={(v) => setCfg({ mode: v })}
                options={[
                  { value: 'fast', label: 'fast 轻量' },
                  { value: 'reason', label: 'reason 推理' },
                ]}
              />
            </div>
            <div>
              <FieldLabel>上游截断</FieldLabel>
              <Input
                type="number"
                value={d.config.max_ctx || 4000}
                onChange={(v) => setCfg({ max_ctx: Number(v) })}
              />
            </div>
            <div className="col-span-2">
              <FieldLabel>指定 provider</FieldLabel>
              <Select
                value={d.config.provider_id || ''}
                onChange={(v) => setCfg({ provider_id: v })}
                options={[
                  { value: '', label: '按设置页自动路由' },
                  ...providers.map((p) => ({ value: p.id, label: p.name })),
                ]}
              />
            </div>
          </div>
        )}

        {/* ---------------- 操作 ---------------- */}
        <div className="mb-3 flex flex-wrap gap-2">
          <Btn variant="primary" onClick={onRun} loading={running}>
            运行此节点
          </Btn>
          <Btn variant="danger" onClick={onDelete}>
            删除节点
          </Btn>
        </div>

        {/* ---------------- 失败原因 ---------------- */}
        {error ? (
          <div className="mb-3">
            <AiError error={error} onRetry={onRun} retrying={running} title="这个节点运行失败" />
          </div>
        ) : null}

        {/* ---------------- 输出 ---------------- */}
        {output && !error ? (
          <div className="mb-3">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11.5px] font-medium text-[color:var(--wb-text-soft)]">输出</span>
              <div className="flex gap-1">
                {onExpandOutput && (
                  <Btn size="sm" onClick={onExpandOutput} title="在大窗口里读完整输出">
                    展开
                  </Btn>
                )}
                <Btn size="sm" onClick={() => onSaveOutput('idea')}>
                  存创新点
                </Btn>
                <Btn size="sm" onClick={() => onSaveOutput('literature')}>
                  存文献
                </Btn>
                <Btn size="sm" onClick={() => onSaveOutput('paper' as any)}>
                  存论文
                </Btn>
              </div>
            </div>
            {(meta?.provider || meta?.tokens_in) && (
              <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-[color:var(--wb-muted)]">
                {meta.provider && <Pill tone="blue">{meta.provider}</Pill>}
                {meta.model && <span className="truncate">{meta.model}</span>}
                {meta.tokens_in ? <span>in {meta.tokens_in}</span> : null}
                {meta.tokens_out ? <span>out {meta.tokens_out}</span> : null}
                {meta.elapsed_ms ? <span>{meta.elapsed_ms} ms</span> : null}
              </div>
            )}
            <div className="max-h-[24rem] overflow-y-auto rounded-[10px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-3 py-2">
              <MdBlock text={output} />
            </div>
            <div className="mt-1 text-[11.5px] text-[color:var(--wb-muted)]">
              AI 生成内容，涉及文献、数字、引用处请人工核验
            </div>
          </div>
        ) : null}

        {/* ---------------- 运行记录 ---------------- */}
        {runs.length > 0 && (
          <details className="rounded-[10px] border border-[color:var(--wb-border)] px-3 py-2">
            <summary className="cursor-pointer text-[11.5px] text-[color:var(--wb-text-soft)]">
              运行记录（{runs.length}）
            </summary>
            <div className="mt-2 flex flex-col gap-1">
              {runs.slice(0, 8).map((r) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between gap-2 rounded-[7px] bg-[color:var(--wb-bg-subtle)] px-2 py-1 text-[10.5px] text-[color:var(--wb-text-soft)]"
                >
                  <span className="tabular-nums">#{r.id}</span>
                  <span className="truncate">
                    {r.scope === 'all' ? '整图' : r.scope} · {r.out_count ?? 0} 节点
                  </span>
                  <span className="shrink-0 tabular-nums text-[color:var(--wb-muted)]">
                    {(r.started_at || '').slice(5, 16)}
                  </span>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  )
}
