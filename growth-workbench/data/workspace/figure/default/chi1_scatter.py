"""χ1 rotamer 三联散点图（X1 AF2 / X1 PDB ensemble / X1 1XQQ ensemble）。

版式复刻自参考画廊 MULTI-1DBA7BB547（质量分第 1 名的三面板散点）。
数据点为示意：从参考图的像素坐标反解到 0–360° 角度域，
rotamer wells 位于 60°(gauche−) / 180°(trans 区间参考) / 300°(gauche+)。
"""
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

# 参考图上逐像素提取的点位（px, py），每面板一组
PIXEL_POINTS = {
    "X1 AF2 structure": [[63,58],[63,65],[64,136],[71,79],[72,72],[172,168],[176,176],[176,222],[180,171],[180,269],[181,189],[184,182],[186,231],[199,251],[268,279],[269,268],[270,247],[274,277],[280,280],[281,272],[283,263],[284,288],[287,278],[290,292],[319,330],[321,315]],
    "X1 PDB ensemble": [[34,58],[56,60],[67,64],[75,72],[80,78],[87,171],[98,136],[176,171],[183,181],[189,176],[202,178],[205,231],[206,251],[209,222],[222,260],[223,280],[230,269],[248,247],[255,189],[260,279],[261,265],[267,282],[276,272],[280,277],[283,263],[284,272],[285,286],[289,278],[293,288],[302,45],[304,291],[313,315],[320,330],[338,292]],
    "X1 1XQQ ensemble": [[15,329],[16,315],[34,58],[47,64],[69,72],[76,171],[79,78],[178,168],[178,279],[182,176],[189,189],[190,183],[192,136],[195,268],[209,265],[215,231],[226,222],[226,247],[239,270],[245,278],[247,329],[256,281],[270,277],[277,251],[278,262],[280,268],[285,280],[290,292],[296,288],[314,60],[315,292],[328,326]],
}

PANEL_ORDER = ["X1 AF2 structure", "X1 PDB ensemble", "X1 1XQQ ensemble"]

# 像素 → 角度线性映射（参考图坐标轴覆盖 0–360°）
PX0, PX1 = 10.0, 340.0
PY0, PY1 = 10.0, 340.0


def to_deg(px: float, py: float) -> tuple[float, float]:
    x = (px - PX0) / (PX1 - PX0) * 360.0
    y = 360.0 - (py - PY0) / (PY1 - PY0) * 360.0
    return round(x, 1), round(y, 1)


DOT_COLOR = "#4285f4"
GUIDES = {
    60: ("gauche\u2212", "#53A380"),
    180: ("trans", "#CF894E"),
    300: ("gauche+", "#EFE668"),
}
DOT_SIZE = 5  # markersize^2，小圆点


def main() -> None:
    data = {}
    for title in PANEL_ORDER:
        data[title] = [to_deg(px, py) for px, py in PIXEL_POINTS[title]]
    Path("chi1_points.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    fig, axes = plt.subplots(1, 3, figsize=(9.0, 3.3), sharex=True, sharey=True)
    fig.subplots_adjust(left=0.075, right=0.985, bottom=0.155, top=0.845, wspace=0.06)

    for ax, title in zip(axes, PANEL_ORDER):
        xs = [p[0] for p in data[title]]
        ys = [p[1] for p in data[title]]
        ax.scatter(xs, ys, s=DOT_SIZE, c=DOT_COLOR, linewidths=0, alpha=0.9)
        for angle, (label, color) in GUIDES.items():
            ax.axvline(angle, color=color, linestyle="--", linewidth=0.8, alpha=0.85)
            ax.axhline(angle, color=color, linestyle="--", linewidth=0.8, alpha=0.85)
        ax.set_xlim(0, 360)
        ax.set_ylim(0, 360)
        ax.set_xticks([0, 90, 180, 270, 360])
        ax.set_yticks([0, 90, 180, 270, 360])
        ax.set_title(title, fontsize=9, pad=6)
        ax.tick_params(labelsize=7.5, length=2.5, width=0.6)
        for spine in ax.spines.values():
            spine.set_linewidth(0.6)
        ax.set_xlabel(r"$\chi_1(i)$ (deg)", fontsize=8.5, labelpad=2)
    axes[0].set_ylabel(r"$\chi_1(i{+}1)$ (deg)", fontsize=8.5, labelpad=2)

    # 图例：三个 rotamer well 颜色
    handles = [
        plt.Line2D([], [], color=c, linestyle="--", linewidth=1.2, label=l)
        for l, c in (("gauche\u2212", "#53A380"), ("trans", "#CF894E"), ("gauche+", "#EFE668"))
    ]
    fig.legend(handles=handles, loc="upper center", ncol=3, fontsize=8, frameon=False, bbox_to_anchor=(0.5, 0.985))

    fig.savefig("chi1_scatter.png", dpi=300)
    fig.savefig("chi1_scatter.pdf")
    print("saved chi1_scatter.png / chi1_scatter.pdf")


if __name__ == "__main__":
    main()