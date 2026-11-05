/**
 * 科研导航：借鉴虫部落「快搜」——
 * 上面填关键词，点哪个站点就用哪个站搜；不填就直接进站点首页。
 * 纯静态链接，零后端、零状态，想加站点往 SITES 里添一行即可。
 */
import { useState } from 'react'
import { Card, PageHeader, SearchInput } from '../components/ui'

type Site = { name: string; url: string; q?: string }

const SITES: { group: string; note: string; sites: Site[] }[] = [
  {
    group: '学术搜索',
    note: '查论文第一站，填关键词点站点直达搜索',
    sites: [
      { name: 'Google Scholar', url: 'https://scholar.google.com', q: 'https://scholar.google.com/scholar?q={q}' },
      { name: 'Semantic Scholar', url: 'https://www.semanticscholar.org', q: 'https://www.semanticscholar.org/search?q={q}' },
      { name: 'arXiv', url: 'https://arxiv.org', q: 'https://arxiv.org/search/?query={q}' },
      { name: 'PubMed', url: 'https://pubmed.ncbi.nlm.nih.gov', q: 'https://pubmed.ncbi.nlm.nih.gov/?term={q}' },
      { name: '百度学术', url: 'https://xueshu.baidu.com', q: 'https://xueshu.baidu.com/s?wd={q}' },
      { name: '知网', url: 'https://www.cnki.net', q: 'https://kns.cnki.net/kns8s/defaultresult/index?kw={q}' },
      { name: 'X-MOL', url: 'https://www.x-mol.com', q: 'https://www.x-mol.com/search/q?option={q}' },
      { name: 'ResearchGate', url: 'https://www.researchgate.net', q: 'https://www.researchgate.net/search?q={q}' },
    ],
  },
  {
    group: '开放获取',
    note: '合法免费的全文来源，找 OA 版本优先去这里',
    sites: [
      { name: 'OpenAlex', url: 'https://openalex.org', q: 'https://openalex.org/works?search={q}' },
      { name: 'Unpaywall', url: 'https://unpaywall.org' },
      { name: 'DOAJ', url: 'https://doaj.org', q: 'https://doaj.org/search/articles?source={q}' },
      { name: 'PubMed Central', url: 'https://www.ncbi.nlm.nih.gov/pmc', q: 'https://www.ncbi.nlm.nih.gov/pmc/?term={q}' },
      { name: 'CORE', url: 'https://core.ac.uk', q: 'https://core.ac.uk/search?q={q}' },
      { name: 'arXiv PDF', url: 'https://arxiv.org/list/cs/recent' },
    ],
  },
  {
    group: '代码与数据',
    note: '复现实验、找数据集',
    sites: [
      { name: 'GitHub', url: 'https://github.com', q: 'https://github.com/search?q={q}&type=repositories' },
      { name: 'Papers With Code', url: 'https://paperswithcode.com', q: 'https://paperswithcode.com/search?q_meta=&q={q}' },
      { name: 'Hugging Face', url: 'https://huggingface.co', q: 'https://huggingface.co/search/full-text?q={q}' },
      { name: 'Kaggle', url: 'https://www.kaggle.com', q: 'https://www.kaggle.com/search?q={q}' },
      { name: 'OpenReview', url: 'https://openreview.net', q: 'https://openreview.net/search?query={q}' },
      { name: 'ModelScope', url: 'https://modelscope.cn' },
    ],
  },
  {
    group: '写作工具',
    note: '排版、公式、图表、文献管理',
    sites: [
      { name: 'Overleaf', url: 'https://www.overleaf.com' },
      { name: 'Zotero', url: 'https://www.zotero.org' },
      { name: 'Connected Papers', url: 'https://www.connectedpapers.com' },
      { name: 'LaTeX 公式编辑器', url: 'https://www.latexlive.com' },
      { name: 'draw.io', url: 'https://app.diagrams.net' },
      { name: 'TableConvert', url: 'https://tableconvert.com' },
    ],
  },
  {
    group: '综合导航',
    note: '站点大全，找不到再来这里兜底',
    sites: [
      { name: '虫部落快搜', url: 'https://chongbuluo.com' },
      { name: '研究导航', url: 'https://sou-yun.cn' },
      { name: 'AMiner', url: 'https://www.aminer.cn', q: 'https://www.aminer.cn/search/pub?q={q}' },
      { name: '中国科技云', url: 'https://www.cstcloud.cn' },
    ],
  },
]

export default function Navigator() {
  const [kw, setKw] = useState('')

  const jump = (s: Site) => {
    const url = kw.trim() && s.q ? s.q.replace('{q}', encodeURIComponent(kw.trim())) : s.url
    window.open(url, '_blank', 'noreferrer')
  }

  return (
    <div className="flex flex-col gap-3.5">
      <PageHeader
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
          <div className="flex flex-wrap gap-2">
            {g.sites.map((s) => (
              <button
                key={s.name}
                type="button"
                onClick={() => jump(s)}
                className="rounded-[9px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-3 py-1.5 text-[12.5px] text-[color:var(--wb-text-soft)] transition hover:border-[color:var(--wb-accent)] hover:bg-[color:var(--wb-accent-soft)] hover:text-[color:var(--wb-accent)]"
              >
                {s.name}
              </button>
            ))}
          </div>
        </Card>
      ))}
    </div>
  )
}
