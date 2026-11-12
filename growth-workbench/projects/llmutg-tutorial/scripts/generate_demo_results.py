# -*- coding: utf-8 -*-
"""
演示数据生成器（DEMO / synthetic）。
用途：为「用工作台生成论文」案例页造一份**可复现的演示实验数据**，
     让整条链路（数据 -> 统计 -> 表格 -> 图 -> 编译）真的跑起来。
硬边界：所有数字都是**合成演示数据**，论文与图表必须标明 DEMO，不得当作真实测量。
"""
import csv, json, math, random
from pathlib import Path

SEED = 20261112
random.seed(SEED)

OUT = Path("web/public/tutorial/llmutg")
TEX = OUT / "llmutg_paper.tex"

N_MODULES = 486                      # 与 CodaMosa 486-module 套件对齐
METHODS = ["codamosa", "coverup", "DMF-Jev"]

# 每种方法的"真实"分布参数（演示用）：均值、标准差
PARAMS = {
    "codamosa": dict(cov=68.4, cov_sd=9.5, valid=0.812, calls=9.6, time=41.0, loc=None),
    "coverup":  dict(cov=71.2, cov_sd=8.9, valid=0.834, calls=10.8, time=52.5, loc=None),
    "DMF-Jev":  dict(cov=75.1, cov_sd=8.2, valid=0.881, calls=5.7, time=44.8, loc=0.787),
}

def clip(x, lo, hi):
    return max(lo, min(hi, x))

rows = []
for m in range(1, N_MODULES + 1):
    # 模块难度：让同一模块在三种方法下相关（paired 设计），便于配对检验
    hard = random.gauss(0, 1)
    for name in METHODS:
        p = PARAMS[name]
        cov = random.gauss(p["cov"] - 3.0 * hard, p["cov_sd"])
        cov = clip(cov, 5.0, 99.0)
        valid = clip(random.gauss(p["valid"], 0.05), 0.30, 1.0)
        calls = max(1.0, random.gauss(p["calls"] + 0.8 * hard, 1.4))
        tsec = max(3.0, random.gauss(p["time"] + 6.0 * hard, 9.0))
        loc = ""
        if p["loc"] is not None:
            loc = round(clip(random.gauss(p["loc"], 0.055), 0.0, 1.0), 3)
        rows.append(dict(module=f"M{m:03d}", method=name,
                         coverage=round(cov, 2), valid_ratio=round(valid, 3),
                         llm_calls=round(calls, 2), time_sec=round(tsec, 1),
                         localization=loc))

# ---------- 统计：中位数 + bootstrap 95% CI + 配对 Wilcoxon(近似) + Cliff's delta ----------
def median(xs):
    s = sorted(xs); n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2

def boot_ci(xs, fn=median, B=1000):
    n = len(xs); out = []
    for _ in range(B):
        out.append(fn([xs[random.randrange(n)] for _ in range(n)]))
    out.sort()
    return out[int(0.025 * B)], out[int(0.975 * B) - 1]

def wilcoxon_p(a, b):
    """Wilcoxon 符号秩检验，正态近似 + 结(ties)修正（大样本 n=486），双侧 p 值。"""
    d = [x - y for x, y in zip(a, b)]
    d = [x for x in d if x != 0]
    n = len(d)
    if n == 0:
        return 1.0
    # 按 |d| 排秩（平均秩处理 ties）
    order = sorted(range(n), key=lambda i: abs(d[i]))
    ranks = [0.0] * n
    i = 0
    while i < n:
        j = i
        while j + 1 < n and abs(d[order[j + 1]]) == abs(d[order[i]]):
            j += 1
        avg = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            ranks[order[k]] = avg
        i = j + 1
    w_plus = sum(ranks[i] for i in range(n) if d[i] > 0)
    mu = n * (n + 1) / 4.0
    sigma = math.sqrt(n * (n + 1) * (2 * n + 1) / 24.0)
    z = (w_plus - mu) / sigma if sigma else 0.0
    return 2 * (1 - 0.5 * (1 + math.erf(abs(z) / math.sqrt(2))))

def cliffs_delta(a, b):
    gt = lt = 0
    for x in a:
        for y in b:
            if x > y: gt += 1
            elif x < y: lt += 1
    return (gt - lt) / (len(a) * len(b))

by = {name: [r for r in rows if r["method"] == name] for name in METHODS}
summary = {}
for name, rs in by.items():
    cov = [r["coverage"] for r in rs]
    lo, hi = boot_ci(cov)
    summary[name] = dict(
        cov_med=median(cov), cov_lo=lo, cov_hi=hi,
        valid_med=median([r["valid_ratio"] for r in rs]),
        calls_med=median([r["llm_calls"] for r in rs]),
        time_med=median([r["time_sec"] for r in rs]),
        loc_med=(median([float(r["localization"]) for r in rs]) if name == "DMF-Jev" else None),
    )

base = [r["coverage"] for r in by["codamosa"]]
ours = [r["coverage"] for r in by["DMF-Jev"]]
calls_base = [r["llm_calls"] for r in by["codamosa"]]
calls_ours = [r["llm_calls"] for r in by["DMF-Jev"]]

p_cov = wilcoxon_p(ours, base)

p_calls = wilcoxon_p(calls_ours, calls_base)
delta = cliffs_delta(ours, base)
d_calls = (median(calls_ours) - median(calls_base)) / median(calls_base) * 100.0
d_cov = summary["DMF-Jev"]["cov_med"] - summary["codamosa"]["cov_med"]

# ---------- 落盘 CSV ----------
with open(OUT / "results_demo.csv", "w", newline="", encoding="utf-8-sig") as f:
    w = csv.DictWriter(f, fieldnames=["module", "method", "coverage", "valid_ratio",
                                      "llm_calls", "time_sec", "localization"])
    w.writeheader()
    for r in rows:
        w.writerow(r)

with open(OUT / "results_demo_summary.json", "w", encoding="utf-8") as f:
    json.dump(dict(seed=SEED, n_modules=N_MODULES, methods=summary,
                   diff=dict(cov_pp=round(d_cov, 2), calls_pct=round(d_calls, 1),
                             p_cov=p_cov, p_calls=p_calls, cliffs_delta=round(delta, 3))),
              f, ensure_ascii=False, indent=2)

def fmt_p(p):
    return "$p<10^{-10}$" if p < 1e-10 else f"$p={p:.2e}$"

def fmt(x, nd=1):
    return f"{x:.{nd}f}"

# ---------- 注入论文：替换 Results 段 ----------
s = summary
pcov = fmt_p(p_cov)
pcalls = fmt_p(p_calls)
results_tex = rf"""\section{{Results}}
\label{{sec:results}}
\textcolor{{warn}}{{\textbf{{DEMO DATA.}} All numbers in this section are generated by a seeded synthetic
generator (\texttt{{results\_demo.py}}, seed {SEED}, $n={N_MODULES}$ modules) for the purpose of
demonstrating the end-to-end pipeline. They are \emph{{not}} measurements and must not be cited as evidence.}}
\begin{{table}}[h]
\centering
\caption{{Demo comparison on the CM-style 486-module suite ($n={N_MODULES}$, synthetic, seed {SEED}).
Medians with bootstrap 95\% CI (1,000 resamples).}}
\label{{tab:cm}}
\begin{{tabular}}{{lcccc}}
\toprule
Method & Coverage (\%) [95\% CI] & Valid ratio & LLM calls & Time (s) \\
\midrule
codamosa (base) & {fmt(s['codamosa']['cov_med'])} [{fmt(s['codamosa']['cov_lo'])}, {fmt(s['codamosa']['cov_hi'])}] & {fmt(s['codamosa']['valid_med'],3)} & {fmt(s['codamosa']['calls_med'])} & {fmt(s['codamosa']['time_med'])} \\
coverup & {fmt(s['coverup']['cov_med'])} [{fmt(s['coverup']['cov_lo'])}, {fmt(s['coverup']['cov_hi'])}] & {fmt(s['coverup']['valid_med'],3)} & {fmt(s['coverup']['calls_med'])} & {fmt(s['coverup']['time_med'])} \\
DMF-Jev (ours) & \textbf{{{fmt(s['DMF-Jev']['cov_med'])}}} [{fmt(s['DMF-Jev']['cov_lo'])}, {fmt(s['DMF-Jev']['cov_hi'])}] & \textbf{{{fmt(s['DMF-Jev']['valid_med'],3)}}} & \textbf{{{fmt(s['DMF-Jev']['calls_med'])}}} & {fmt(s['DMF-Jev']['time_med'])} \\
\bottomrule
\end{{tabular}}
\end{{table}}

Compared with \texttt{{codamosa}}, DMF-Jev gains \textbf{{{fmt(d_cov)}}} percentage points of median coverage
({pcov}, Cliff's $\delta={delta:.2f}$) while reducing LLM calls by
\textbf{{{fmt(abs(d_calls))}\%}} ({pcalls}). Localization accuracy of the
node-level selector on these demo modules is {fmt(s['DMF-Jev']['loc_med'], 3)}.

\begin{{figure}}[h]
\centering
\begin{{tikzpicture}}[x=1.5cm,y=0.055cm, font=\small]
  \draw[->] (0,0) -- (4.2,0) node[right] {{method}};
  \draw[->] (0,0) -- (0,86) node[above] {{coverage (\%)}};
  \foreach \x/\l in {{1/codamosa,2/coverup,3/DMF-Jev}} \node[below] at (\x,0) {{\l}};
  \draw[accent, fill=accent!25] (0.7,0) rectangle (1.3,{fmt(s['codamosa']['cov_med'])});
  \draw[accent, fill=accent!25] (1.7,0) rectangle (2.3,{fmt(s['coverup']['cov_med'])});
  \draw[accent, fill=accent!55] (2.7,0) rectangle (3.3,{fmt(s['DMF-Jev']['cov_med'])});
  % 95\% CI 误差棒
  \draw[thick] (1,{fmt(s['codamosa']['cov_lo'])}) -- (1,{fmt(s['codamosa']['cov_hi'])});
  \draw[thick] (2,{fmt(s['coverup']['cov_lo'])}) -- (2,{fmt(s['coverup']['cov_hi'])});
  \draw[thick] (3,{fmt(s['DMF-Jev']['cov_lo'])}) -- (3,{fmt(s['DMF-Jev']['cov_hi'])});
  \node[font=\tiny,gray] at (2,80) {{DEMO (synthetic)}};
\end{{tikzpicture}}
\caption{{Median coverage with bootstrap 95\% CI. Synthetic demo data (seed {SEED}); not measurements.}}
\label{{fig:bars}}
\end{{figure}}
"""

start = s_marker = "\\section{Results}"
end = "\\section{Discussion}"
i, j = TEX.read_text(encoding="utf-8").find(start), TEX.read_text(encoding="utf-8").find(end)
assert i != -1 and j != -1 and i < j, "Results 段定位失败"
tex = TEX.read_text(encoding="utf-8")
TEX.write_text(tex[:i] + results_tex + "\n" + tex[j:], encoding="utf-8")

# 摘要里那句"illustrative placeholders"改成 demo 表述，避免自相矛盾
tex = TEX.read_text(encoding="utf-8")
tex = tex.replace(
    "All quantitative results in this draft are \\textcolor{warn}{illustrative placeholders} to be replaced with measured values; the manuscript separates real from simulated data by construction.",
    "All quantitative results in this draft are computed from a \\textcolor{warn}{seeded synthetic generator (DEMO)} to exercise the full pipeline end to end; they are explicitly flagged as non-measurements, and the manuscript separates real from simulated data by construction.")
tex = tex.replace(
    "\\textcolor{warn}{In this draft all values are illustrative.}",
    "\\textcolor{warn}{In this draft all values are DEMO (synthetic, seed %d).}" % SEED)
TEX.write_text(tex, encoding="utf-8")

print("rows:", len(rows))
print("summary:", json.dumps(dict(cov_pp=round(d_cov,2), calls_pct=round(d_calls,1),
                                 p_cov=p_cov, p_calls=p_calls, cliffs=round(delta,3)), ensure_ascii=False))
print("wrote results_demo.csv / results_demo_summary.json / patched llmutg_paper.tex")
