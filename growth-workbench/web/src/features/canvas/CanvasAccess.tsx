/** 访问点：图 3 的四张卡。状态与地址都来自本机真实服务，未实现的能力明确标停用/不可用。 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Btn, Input } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { usePersist } from '../../lib/state'
import {
  CanvasSelect,
  EmptyHint,
  NeedCanvas,
  ServiceState,
  SubCard,
  SubHead,
  UrlRow,
  useCanvasPicker,
} from './CanvasSub'

export default function CanvasAccess({
  embedded = false,
}: {
  /** 嵌入设置页时：不渲染自己的小标题与画布选择器（外层统一管理） */
  embedded?: boolean
} = {}) {
  const { cid, setCid, canvases } = useCanvasPicker()
  const nav = useNavigate()
  const [editingDesc, setEditingDesc] = useState(false)
  const [mcpDesc, setMcpDesc] = usePersist<string>(`canvas.mcpDesc.${cid ?? 0}`, '')

  if (!cid) return <NeedCanvas />

  const origin = window.location.origin
  const webUrl = `${origin}/`
  const apiUrl = `${origin}/api/canvas/dify/openapi`
  // MCP 服务目前没有实现，地址只作占位展示并遮蔽，不伪装成可用
  const mcpUrl = `${origin}/api/canvas/mcp`

  return (
    <div className={embedded ? 'px-1 py-1' : 'h-full overflow-y-auto px-6 py-5'}>
      <div className="mx-auto w-full max-w-[1080px]">
        <SubHead
          title="访问点"
          desc="此应用的所有访问点。访问点仅对当前运行版本生效。"
          actions={embedded ? undefined : <CanvasSelect cid={cid} setCid={setCid} canvases={canvases} />}
        />

        <div className="mb-3 text-[11px] font-medium uppercase tracking-[0.14em] text-[color:var(--wb-muted)]">
          内置
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* 1. Web 应用：本机 SPA 实际在跑 */}
          <SubCard
            icon={<Icon name="panel" size={16} />}
            title="Web 应用"
            desc="通过浏览器网页使用应用"
            state={<ServiceState tone="ok" text="服务中" />}
          >
            <div className="mb-1 text-[10.5px] font-medium text-[color:var(--wb-muted)]">访问 URL</div>
            <UrlRow value={webUrl} canOpen />
            <div className="mt-auto flex flex-wrap gap-1.5 pt-3">
              <Btn size="sm" onClick={() => nav('/navigator')}>
                <Icon name="panel" size={12} />
                自定义前端
              </Btn>
              <Btn size="sm" onClick={() => nav('/settings')}>
                <Icon name="gear" size={12} />
                设置
              </Btn>
            </div>
          </SubCard>

          {/* 2. 后端服务 API：/api/canvas/dify/openapi 是真实端点 */}
          <SubCard
            icon={<Icon name="gitBranch" size={16} />}
            title="后端服务 API"
            desc="通过 HTTP 将应用集成到你的服务中"
            state={<ServiceState tone="ok" text="服务中" />}
          >
            <div className="mb-1 text-[10.5px] font-medium text-[color:var(--wb-muted)]">API Endpoint</div>
            <UrlRow value={apiUrl} canOpen />
            <div className="mt-auto flex flex-wrap items-center gap-2 pt-3">
              <Btn size="sm" onClick={() => nav('/settings')}>
                <Icon name="lock" size={12} />
                API 密钥
              </Btn>
              <button
                type="button"
                onClick={() => window.open(`${origin}/docs`, '_blank', 'noopener,noreferrer')}
                className="wb-press-soft inline-flex items-center gap-1 text-[11.5px] text-[color:var(--wb-accent)] hover:underline"
              >
                <Icon name="book" size={12} />
                查阅 API 文档 ↗
              </button>
              <span className="text-[10.5px] text-[color:var(--wb-muted)]">本机模式无需密钥</span>
            </div>
          </SubCard>

          {/* 3. MCP 服务：未实现，明确标停用 */}
          <SubCard
            icon={<Icon name="hexagon" size={16} />}
            title="MCP 服务"
            desc="将应用作为工具提供给 Agent 和 AI 应用"
            state={<ServiceState tone="off" text="已停用" />}
          >
            <div className="mb-1 text-[10.5px] font-medium text-[color:var(--wb-muted)]">服务端点 URL</div>
            <UrlRow value={mcpUrl} masked />
            <div className="mt-auto pt-3">
              {editingDesc ? (
                <div className="flex items-center gap-1.5">
                  <Input
                    value={mcpDesc}
                    onChange={setMcpDesc}
                    placeholder="给这个访问点写一句说明"
                    className="!py-1 !text-[11.5px]"
                  />
                  <Btn size="sm" onClick={() => setEditingDesc(false)}>
                    保存
                  </Btn>
                </div>
              ) : (
                <Btn size="sm" onClick={() => setEditingDesc(true)}>
                  <Icon name="plus" size={12} />
                  添加描述
                </Btn>
              )}
              {mcpDesc && !editingDesc && (
                <div className="mt-1.5 truncate text-[11px] text-[color:var(--wb-text-soft)]" title={mcpDesc}>
                  {mcpDesc}
                </div>
              )}
            </div>
          </SubCard>

          {/* 4. 触发器：未实现，图 3 的空状态 */}
          <SubCard
            icon={<Icon name="radar" size={16} />}
            title="触发器"
            desc="当前运行版本中的触发器节点"
            state={<ServiceState tone="na" text="不可用" />}
          >
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center text-center">
              <div className="text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
                发布后，触发器会显示在这里。
                <button
                  type="button"
                  onClick={() => window.open(`${origin}/docs`, '_blank', 'noopener,noreferrer')}
                  className="ml-1 text-[color:var(--wb-accent)] hover:underline"
                >
                  进一步了解触发器 ↗
                </button>
              </div>
            </div>
          </SubCard>
        </div>

        {canvases.length === 0 && (
          <EmptyHint title="还没有画布">在编排页新建一块画布后，访问点会跟着出现。</EmptyHint>
        )}
      </div>
    </div>
  )
}
