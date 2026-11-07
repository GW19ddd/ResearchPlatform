import { useEffect, useState } from 'react'
import { Icon, IconName } from '../../components/Icon'
import { IconBtn } from '../../components/ui'
import Settings, { SettingsSection } from '../../pages/Settings'

type SectionKey = Exclude<SettingsSection, 'all'>

/** 左侧分类表：与 Settings.tsx 的 section 一一对应 */
const SECTIONS: {
  key: SectionKey
  label: string
  desc: string
  hint: string
  icon: IconName
}[] = [
  {
    key: 'account',
    label: '账户',
    desc: '个人资料与登录',
    hint: '改称呼、头像颜色，或重设密码',
    icon: 'user',
  },
  {
    key: 'model',
    label: '模型供应商',
    desc: 'API 与调用统计',
    hint: '增删改供应商、测试连通，按任务分派快模型与推理模型',
    icon: 'sparkle',
  },
  {
    key: 'dify',
    label: 'Dify 应用',
    desc: '编排画布节点',
    hint: '填一次地址与 Key，画布里的 Dify 节点就能直接用',
    icon: 'hexagon',
  },
  {
    key: 'zotero',
    label: 'Zotero 同步',
    desc: '文献批量导入',
    hint: '本地 Zotero / Web API 同步，或粘贴 BibTeX、RIS、CSL JSON 离线导入',
    icon: 'book',
  },
  {
    key: 'data',
    label: '数据与维护',
    desc: '备份 / 污染清理',
    hint: '本地数据库快照、恢复，以及 AI 污染条目检查',
    icon: 'shield',
  },
]

/**
 * 侧边栏左下角齿轮打开的设置面板：左侧分类栏 + 右侧内容。
 * 内容直接复用 pages/Settings.tsx（embedded + section），不复制一份表单逻辑。
 */
export default function SettingsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [section, setSection] = useState<SectionKey>('model')

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  const cur = SECTIONS.find((s) => s.key === section) || SECTIONS[0]

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-3 sm:p-5">
      <div
        className="wb-anim-fade absolute inset-0 bg-[rgba(16,17,20,0.36)] backdrop-blur-[3px]"
        onClick={onClose}
      />
      <div className="wb-anim-pop relative flex h-[min(680px,90vh)] w-[min(980px,96vw)] overflow-hidden rounded-[18px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] shadow-[var(--wb-shadow-lg)]">
        {/* 左侧分类栏 */}
        <aside className="hidden w-[210px] shrink-0 flex-col border-r border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] sm:flex">
          <div className="px-4 pb-3 pt-4">
            <div className="text-[13px] font-semibold tracking-[-0.01em] text-[color:var(--wb-text)]">设置</div>
            <div className="mt-0.5 text-[10.5px] text-[color:var(--wb-muted)]">全部保存在本机</div>
          </div>

          <nav className="flex flex-col gap-[3px] px-2.5" aria-label="设置分类">
            {SECTIONS.map((s) => {
              const active = s.key === section
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setSection(s.key)}
                  aria-current={active ? 'page' : undefined}
                  className={`flex items-center gap-2.5 rounded-[9px] border-l-2 py-2 pl-2.5 pr-2 text-left transition-colors ${
                    active
                      ? 'border-[color:var(--wb-accent)] bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent)]'
                      : 'border-transparent text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]'
                  }`}
                >
                  <Icon name={s.icon} size={15} className="shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium">{s.label}</span>
                    <span className={`block truncate text-[10.5px] ${active ? 'text-[color:var(--wb-accent)] opacity-70' : 'text-[color:var(--wb-muted)]'}`}>
                      {s.desc}
                    </span>
                  </span>
                </button>
              )
            })}
          </nav>

          <div className="mt-auto border-t border-[color:var(--wb-border)] px-4 py-3 text-[10.5px] leading-relaxed text-[color:var(--wb-muted)]">
            数据只存在这台电脑，可在「数据与维护」里导出备份。
          </div>
        </aside>

        {/* 右侧内容区 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[color:var(--wb-border)] px-5 py-3.5">
            <div className="min-w-0">
              <div className="text-[14px] font-semibold tracking-[-0.01em] text-[color:var(--wb-text)]">
                {cur.label}
              </div>
              <div className="truncate text-[11.5px] text-[color:var(--wb-muted)]">{cur.hint}</div>
            </div>
            <IconBtn icon="close" size="md" ariaLabel="关闭设置" title="关闭（Esc）" onClick={onClose} />
          </header>

          {/* 窄屏没有左侧栏时给一排分类切换 */}
          <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-[color:var(--wb-border)] px-3 py-2 sm:hidden">
            {SECTIONS.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => setSection(s.key)}
                className={`whitespace-nowrap rounded-[8px] px-2.5 py-1 text-[11.5px] transition-colors ${
                  s.key === section
                    ? 'bg-[color:var(--wb-accent-soft)] font-medium text-[color:var(--wb-accent)]'
                    : 'text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-bg-subtle)]'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto bg-[color:var(--wb-bg-subtle)] px-4 py-4 sm:px-5">
            <Settings embedded section={section} />
          </div>
        </div>
      </div>
    </div>
  )
}
