/**
 * 科研导航：借鉴虫部落「快搜」——
 * 上面填关键词，点哪个站点就用哪个站搜；不填就直接进站点首页。
 *
 * 图标：各站点官方 favicon / 品牌矢量图标，已下载到 public/site-icons/，
 * 本地离线可用（不依赖第三方图标服务）。想加站点：往 SITES 添一行 + 放一个图标文件。
 */
import { useState } from 'react'
import { Card, PageHeader, SearchInput } from '../components/ui'

type Site = { name: string; url: string; q?: string; icon: string }

const SITES: { group: string; note: string; sites: Site[] }[] = [
  {
    group: '学术搜索',
    note: '查论文第一站，填关键词点站点直达搜索',
    sites: [
      { name: 'Google Scholar', url: 'https://scholar.google.com', q: 'https://scholar.google.com/scholar?q={q}', icon: 'google-scholar.png' },
      { name: 'Semantic Scholar', url: 'https://www.semanticscholar.org', q: 'https://www.semanticscholar.org/search?q={q}', icon: 'semantic-scholar.png' },
      { name: 'arXiv', url: 'https://arxiv.org', q: 'https://arxiv.org/search/?query={q}', icon: 'arxiv.png' },
      { name: 'PubMed', url: 'https://pubmed.ncbi.nlm.nih.gov', q: 'https://pubmed.ncbi.nlm.nih.gov/?term={q}', icon: 'pubmed.png' },
      { name: '百度学术', url: 'https://xueshu.baidu.com', q: 'https://xueshu.baidu.com/s?wd={q}', icon: 'baidu-xueshu.png' },
      { name: '知网', url: 'https://www.cnki.net', q: 'https://kns.cnki.net/kns8s/defaultresult/index?kw={q}', icon: 'cnki.png' },
      { name: 'X-MOL', url: 'https://www.x-mol.com', q: 'https://www.x-mol.com/search/q?option={q}', icon: 'x-mol.png' },
      { name: 'ResearchGate', url: 'https://www.researchgate.net', q: 'https://www.researchgate.net/search?q={q}', icon: 'researchgate.png' },
    ],
  },
  {
    group: '开放获取',
    note: '合法免费的全文来源，找 OA 版本优先去这里',
    sites: [
      { name: 'OpenAlex', url: 'https://openalex.org', q: 'https://openalex.org/works?search={q}', icon: 'openalex.png' },
      { name: 'Unpaywall', url: 'https://unpaywall.org', icon: 'unpaywall.png' },
      { name: 'DOAJ', url: 'https://doaj.org', q: 'https://doaj.org/search/articles?source={q}', icon: 'doaj.png' },
      { name: 'PubMed Central', url: 'https://www.ncbi.nlm.nih.gov/pmc', q: 'https://www.ncbi.nlm.nih.gov/pmc/?term={q}', icon: 'pubmed-central.png' },
      { name: 'CORE', url: 'https://core.ac.uk', q: 'https://core.ac.uk/search?q={q}', icon: 'core.png' },
      { name: 'arXiv PDF', url: 'https://arxiv.org/list/cs/recent', icon: 'arxiv-pdf.png' },
    ],
  },
  {
    group: '代码与数据',
    note: '复现实验、找数据集',
    sites: [
      { name: 'GitHub', url: 'https://github.com', q: 'https://github.com/search?q={q}&type=repositories', icon: 'github.png' },
      { name: 'Papers With Code', url: 'https://paperswithcode.com', q: 'https://paperswithcode.com/search?q_meta=&q={q}', icon: 'papers-with-code.svg' },
      { name: 'Hugging Face', url: 'https://huggingface.co', q: 'https://huggingface.co/search/full-text?q={q}', icon: 'hugging-face.svg' },
      { name: 'Kaggle', url: 'https://www.kaggle.com', q: 'https://www.kaggle.com/search?q={q}', icon: 'kaggle.png' },
      { name: 'OpenReview', url: 'https://openreview.net', q: 'https://openreview.net/search?query={q}', icon: 'openreview.png' },
      { name: 'ModelScope', url: 'https://modelscope.cn', icon: 'modelscope.png' },
    ],
  },
  {
    group: '写作工具',
    note: '排版、公式、图表、文献管理',
    sites: [
      { name: 'Overleaf', url: 'https://www.overleaf.com', icon: 'overleaf.png' },
      { name: 'Zotero', url: 'https://www.zotero.org', icon: 'zotero.png' },
      { name: 'Connected Papers', url: 'https://www.connectedpapers.com', icon: 'connected-papers.png' },
      { name: 'LaTeX 公式编辑器', url: 'https://www.latexlive.com', icon: 'latexlive.png' },
      { name: 'draw.io', url: 'https://app.diagrams.net', icon: 'drawio.png' },
      { name: 'TableConvert', url: 'https://tableconvert.com', icon: 'tableconvert.png' },
    ],
  },
  {
    group: '综合导航',
    note: '站点大全，找不到再来这里兜底',
    sites: [
      { name: '虫部落快搜', url: 'https://chongbuluo.com', icon: 'chongbuluo.png' },
      { name: '研究导航', url: 'https://sou-yun.cn', icon: 'sou-yun.png' },
      { name: 'AMiner', url: 'https://www.aminer.cn', q: 'https://www.aminer.cn/search/pub?q={q}', icon: 'aminer.png' },
      { name: '中国科技云', url: 'https://www.cstcloud.cn', icon: 'cstcloud.png' },
    ],
  },
]

/** 单个站点卡片：官方图标在上、名称在下；图标缺失时退回首字母，不出现破图 */
function SiteCard({ site, hint, onClick }: { site: Site; hint: string; onClick: () => void }) {
  const [failed, setFailed] = useState(false)
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      aria-label={hint}
      className="group flex min-h-[96px] flex-col items-center justify-center gap-2 rounded-[12px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-2 py-3 shadow-[var(--wb-shadow-xs)] transition-all duration-150 hover:-translate-y-[2px] hover:border-[color:var(--wb-accent)] hover:bg-[color:var(--wb-accent-soft)] hover:shadow-[var(--wb-shadow-md)] active:translate-y-0"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] transition group-hover:border-[color:var(--wb-accent)] group-hover:bg-[color:var(--wb-surface)]">
        {failed ? (
          <span className="text-[14px] font-semibold text-[color:var(--wb-accent)]">
            {site.name.trim().charAt(0).toUpperCase()}
          </span>
        ) : (
          <img
            src={`/site-icons/${site.icon}`}
            alt=""
            loading="lazy"
            onError={() => setFailed(true)}
            className="h-7 w-7 object-contain"
          />
        )}
      </span>
      <span className="line-clamp-2 w-full text-center text-[11.5px] font-medium leading-tight text-[color:var(--wb-text-soft)] transition group-hover:text-[color:var(--wb-accent)]">
        {site.name}
      </span>
    </button>
  )
}

export default function Navigator() {
  const [kw, setKw] = useState('')

  const jump = (s: Site) => {
    const url = kw.trim() && s.q ? s.q.replace('{q}', encodeURIComponent(kw.trim())) : s.url
    window.open(url, '_blank', 'noreferrer')
  }

  return (
    <div className="flex flex-col gap-3.5">
      <PageHeader
        eyebrow="检索 · 工具"
        title="科研导航"
        desc="填上关键词再点站点，就是用它搜；不填直接进首页"
      />

      <Card>
        <SearchInput
          value={kw}
          onChange={setKw}
          placeholder="快搜关键词，例：LLM agent CFD"
          className="w-full"
        />
      </Card>

      {SITES.map((g) => (
        <Card key={g.group} title={g.group} extra={<span className="text-[11.5px] text-[color:var(--wb-muted)]">{g.note}</span>}>
          <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4 md:grid-cols-6 xl:grid-cols-8">
            {g.sites.map((s) => (
              <SiteCard
                key={s.name}
                site={s}
                hint={kw.trim() && s.q ? `用「${kw.trim()}」在 ${s.name} 搜索` : `打开 ${s.name}`}
                onClick={() => jump(s)}
              />
            ))}
          </div>
        </Card>
      ))}
    </div>
  )
}
