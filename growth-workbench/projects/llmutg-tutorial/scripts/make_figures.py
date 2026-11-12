# -*- coding: utf-8 -*-
"""用演示数据重出 SVG 图（架构图 + 结果图），配色沿用纸墨。"""
import csv, json, statistics
from pathlib import Path

OUT = Path("web/public/tutorial/llmutg")
INK, GREEN, RED, LINE, PAPER = "#1A1A1A", "#2F5D50", "#A4262C", "#E4E0D8", "#FBFAF7"

rows = list(csv.DictReader(open(OUT / "results_demo.csv", encoding="utf-8-sig")))
sm = json.load(open(OUT / "results_demo_summary.json", encoding="utf-8"))["methods"]
NAMES = [("codamosa", "codamosa"), ("coverup", "coverup"), ("DMF-Jev", "DMF-Jev (ours)")]

# ---------------- 结果对比图：三组小多图（覆盖率 / LLM 调用 / 验证率） ----------------
W, H = 760, 300
panels = [
    ("Coverage (%)", "cov_med", "cov_lo", "cov_hi"),
    ("LLM calls / module", "calls_med", None, None),
    ("Valid test ratio", "valid_med", None, None),
]
pw = W / 3
svg = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">',
       f'<rect width="{W}" height="{H}" fill="{PAPER}"/>']
for pi, (title, key, lo, hi) in enumerate(panels):
    x0 = pi * pw + 40
    bw = 46
    vals = [sm[m][key] for m, _ in NAMES]
    top = max(vals) * 1.18
    base = H - 56
    plot_h = base - 46
    svg.append(f'<text x="{x0}" y="26" font-size="12.5" font-weight="700" fill="{INK}">{title}</text>')
    svg.append(f'<line x1="{x0-8}" y1="{base}" x2="{x0+3*bw+28}" y2="{base}" stroke="{LINE}" stroke-width="1"/>')
    for i, ((m, label), v) in enumerate(zip(NAMES, vals)):
        bx = x0 + i * (bw + 18)
        bh = v / top * plot_h
        fill = GREEN if m == "DMF-Jev" else "#BFCFC9"
        op = "0.95" if m == "DMF-Jev" else "0.75"
        svg.append(f'<rect x="{bx:.1f}" y="{base-bh:.1f}" width="{bw}" height="{bh:.1f}" fill="{fill}" fill-opacity="{op}" rx="3"/>')
        txt = f"{v:.1f}" if key != "valid_med" else f"{v:.3f}"
        svg.append(f'<text x="{bx+bw/2:.1f}" y="{base-bh-6:.1f}" font-size="11" text-anchor="middle" fill="{INK}" font-weight="600">{txt}</text>')
        if lo:
            l, h2 = sm[m][lo], sm[m][hi]
            yl, yh = base - l / top * plot_h, base - h2 / top * plot_h
            cx = bx + bw / 2
            svg.append(f'<line x1="{cx:.1f}" y1="{yl:.1f}" x2="{cx:.1f}" y2="{yh:.1f}" stroke="{INK}" stroke-width="1.2"/>')
            svg.append(f'<line x1="{cx-6:.1f}" y1="{yl:.1f}" x2="{cx+6:.1f}" y2="{yl:.1f}" stroke="{INK}" stroke-width="1.2"/>')
            svg.append(f'<line x1="{cx-6:.1f}" y1="{yh:.1f}" x2="{cx+6:.1f}" y2="{yh:.1f}" stroke="{INK}" stroke-width="1.2"/>')
        # 轴标签（斜置避免重叠）
        svg.append(f'<text x="{bx+bw/2:.1f}" y="{base+16}" font-size="10.5" text-anchor="middle" fill="{INK}">{label}</text>')
svg.append(f'<text x="{W-12}" y="{H-10}" font-size="9.5" text-anchor="end" fill="#8A857C">DEMO synthetic data · seed 20261112 · n=486 modules · not measurements</text>')
svg.append("</svg>")
(OUT / "fig_results.svg").write_text("\n".join(svg), encoding="utf-8")

# ---------------- 架构图（保持原样，若已存在则跳过） ----------------
arch = OUT / "architecture.svg"
if not arch.exists():
    print("architecture.svg missing — keep previous")
print("regenerated fig_results.svg")
