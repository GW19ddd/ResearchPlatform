/**
 * 全局设置里的「论文速递」卡片：学科 / 研究方向 / 邮箱投喂 / 语言显示。
 * 独立于速递页存在——速递页右上角「设置」只是把这份全局设置打开到对应分类。
 */
import { useEffect, useState } from 'react'
import { Btn, Card, Input, Segmented } from '../../components/ui'
import { get, put } from '../../lib/api'
import { useAction } from '../../lib/hooks'

const FALLBACK_SUBJECTS = [
  'cs.LG', 'cs.CL', 'cs.AI', 'cs.CV', 'cs.SE', 'cs.CR', 'cs.PL', 'cs.DC',
  'stat.ML', 'math.OC', 'eess.SP', 'eess.AS', 'cs.HC', 'cs.IR',
]

const LANG_OPTIONS = [
  { value: 'en', label: 'English' },
  { value: 'zh', label: '中文' },
  { value: 'both', label: '双语' },
]

export default function PaperFeedCard() {
  const [options, setOptions] = useState<string[]>(FALLBACK_SUBJECTS)
  const [subjects, setSubjects] = useState<string[]>([])
  const [keywords, setKeywords] = useState('')
  const [email, setEmail] = useState('')
  const [imapHost, setImapHost] = useState('')
  const [imapPort, setImapPort] = useState('993')
  const [imapUser, setImapUser] = useState('')
  const [imapPass, setImapPass] = useState('')
  const [language, setLanguage] = useState<'en' | 'zh' | 'both'>('both')
  const [savedFlash, setSavedFlash] = useState('')
  const { busy, run } = useAction()

  useEffect(() => {
    get('/paperfeed/subjects')
      .then((d) => Array.isArray(d?.options) && d.options.length && setOptions(d.options))
      .catch(() => {})
    get('/paperfeed/settings')
      .then((s: any) => {
        setSubjects(s.subjects || [])
        setKeywords(s.keywords || '')
        setEmail(s.email || '')
        setImapHost(s.imap_host || '')
        setImapPort(String(s.imap_port || 993))
        setImapUser(s.imap_user || '')
        setImapPass(s.imap_pass ? '***' : '')
        setLanguage(s.language === 'zh' || s.language === 'en' ? s.language : 'both')
      })
      .catch(() => {})
  }, [])

  const toggleSubject = (s: string) =>
    setSubjects((v) => (v.includes(s) ? v.filter((x) => x !== s) : [...v, s]))

  const save = () =>
    run(async () => {
      await put(
        '/paperfeed/settings',
        {
          subjects,
          keywords,
          email,
          imap_host: imapHost,
          imap_port: Number(imapPort) || 993,
          imap_user: imapUser,
          imap_pass: imapPass,
          language,
        },
        { ok: false },
      )
      setSavedFlash('已保存')
      setTimeout(() => setSavedFlash(''), 2000)
      window.dispatchEvent(new Event('wb:data-changed'))
    })

  return (
    <Card
      title="论文速递"
      extra={
        <div className="flex items-center gap-2">
          {savedFlash && <span className="text-[12px] text-[color:var(--wb-ok)]">{savedFlash}</span>}
          <Btn variant="primary" loading={busy} onClick={save}>
            保存
          </Btn>
        </div>
      }
    >
      <p className="text-[12px] leading-relaxed text-[color:var(--wb-text-soft)]">
        论文速递页按学科 + 关键词从 arXiv 拉最新论文，像刷短视频一样竖滑浏览；也可以把论文发到下面配置的邮箱，点「检查邮箱」进卡片流。
      </p>

      {/* 语言显示 */}
      <div className="mt-4">
        <div className="mb-1.5 text-[12px] font-medium text-[color:var(--wb-text-soft)]">内容语言显示</div>
        <Segmented value={language} onChange={(v) => setLanguage(v as 'en' | 'zh' | 'both')} options={LANG_OPTIONS} />
        <div className="mt-1.5 text-[11.5px] text-[color:var(--wb-muted)]">
          中文 / 双语会用已配置的快模型翻译标题与摘要，翻译结果缓存进本地库，同一篇只翻一次。
        </div>
      </div>

      {/* 学科 chips：不能被 label 包住（Field 会渲染成 label，点击会串），用普通 div */}
      <div className="mt-4">
        <div className="mb-1.5 text-[12px] font-medium text-[color:var(--wb-text-soft)]">
          学科（arXiv 分类，可多选）
        </div>
        <div className="flex flex-wrap gap-2">
          {options.map((s) => {
            const on = subjects.includes(s)
            return (
              <button
                key={s}
                type="button"
                onClick={() => toggleSubject(s)}
                aria-pressed={on}
                className={`rounded-full border px-3 py-1 font-mono text-[12px] transition-colors ${
                  on
                    ? 'border-[color:var(--wb-accent)] bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent)]'
                    : 'border-[color:var(--wb-border)] text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-bg-subtle)]'
                }`}
              >
                {s}
              </button>
            )
          })}
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <label className="block md:col-span-2">
          <span className="mb-1 block text-[12px] font-medium text-[color:var(--wb-text-soft)]">研究方向关键词</span>
          <Input
            value={keywords}
            onChange={setKeywords}
            placeholder="例如：unit test, mutation testing（逗号 / 空格分隔）"
          />
          <span className="mt-1 block text-[11.5px] text-[color:var(--wb-muted)]">
            与学科取交集过滤 arXiv 最新提交。
          </span>
        </label>
        <label className="block md:col-span-2">
          <span className="mb-1 block text-[12px] font-medium text-[color:var(--wb-text-soft)]">接收邮箱</span>
          <Input value={email} onChange={setEmail} placeholder="you@example.com" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] font-medium text-[color:var(--wb-text-soft)]">IMAP 服务器</span>
          <Input value={imapHost} onChange={setImapHost} placeholder="imap.qq.com" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] font-medium text-[color:var(--wb-text-soft)]">端口</span>
          <Input value={imapPort} onChange={setImapPort} placeholder="993" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] font-medium text-[color:var(--wb-text-soft)]">IMAP 账号</span>
          <Input value={imapUser} onChange={setImapUser} placeholder="邮箱账号" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] font-medium text-[color:var(--wb-text-soft)]">授权码</span>
          <Input
            value={imapPass}
            onChange={setImapPass}
            placeholder={imapPass === '***' ? '已配置（保持 *** 不变）' : '授权码（不是登录密码）'}
          />
        </label>
      </div>
      <p className="mt-3 text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
        QQ / 163 等邮箱需先在邮箱设置里开启 IMAP 并生成授权码。之后把论文（arXiv 链接 / id / 标题摘要）发到这个邮箱，速递页点「检查邮箱」即可收录。
      </p>
    </Card>
  )
}
