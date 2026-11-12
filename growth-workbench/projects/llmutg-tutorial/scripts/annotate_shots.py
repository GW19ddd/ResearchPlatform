# -*- coding: utf-8 -*-
"""按 playwright 读到的真实元素坐标（CSS px）在 2x 截图上画标注框。

版式（避免压内容）：
  框   —— 圆角描边（朱红 #A4262C / 松绿 #2F5D50）
  徽章 —— 框外侧贴一个实心圆角编号（优先左上外侧，越界依次换 右上 / 左上内 / 左下外侧）
  标签 —— 白底描边气泡，优先放在「离元素最近且不越界、不压别的框/气泡」的位置
"""
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
import json, os

SHOTS = Path("web/public/tutorial/llmutg/shots")
SCALE = 2
RED, GREEN, WHITE = (164, 38, 44), (47, 93, 80), (255, 255, 255)

FONTS = [r"C:\Windows\Fonts\msyhbd.ttc", r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simhei.ttf"]


def font(size):
    for p in FONTS:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


def overlap(a, b, pad=0):
    return not (a[2] + pad < b[0] or a[0] > b[2] + pad or a[3] + pad < b[1] or a[1] > b[3] + pad)


def process(name, data):
    im = Image.open(SHOTS / f"{name}.png").convert("RGB")
    W, H = im.size
    draw = ImageDraw.Draw(im)
    f_num = font(int(12.5 * SCALE))
    f_txt = font(int(10.5 * SCALE))
    BOTTOM = H - int(34 * SCALE)   # 右下角水印区保留

    rects = []
    for b in data["boxes"]:
        rects.append((
            max(2, b["x"] * SCALE),
            max(2, b["y"] * SCALE),
            min(W - 2, (b["x"] + b["w"]) * SCALE),
            min(H - 2, (b["y"] + b["h"]) * SCALE),
        ))

    used = list(rects)

    def free(r, self_i):
        if r[0] < 4 or r[1] < 4 or r[2] > W - 4 or r[3] > BOTTOM:
            return False
        for j, u in enumerate(used):
            if j == self_i:
                continue
            if overlap(r, u, pad=int(2 * SCALE)):
                return False
        return True

    for i, b in enumerate(data["boxes"]):
        x1, y1, x2, y2 = rects[i]
        if x2 <= x1 or y2 <= y1 or x2 <= 4 or y2 <= 4:
            print("  skip (offscreen):", name, b.get("label", ""))
            continue
        color = RED if b.get("tone") == "r" else GREEN
        draw.rounded_rectangle([x1, y1, x2, y2], radius=max(8, int(6 * SCALE)),
                               outline=color, width=max(3, int(2.1 * SCALE)))

        # ---- 编号徽章
        num = str(i + 1)
        nb = draw.textbbox((0, 0), num, font=f_num)
        nw = nb[2] - nb[0] + int(11 * SCALE)
        nh = nb[3] - nb[1] + int(7 * SCALE)
        o = int(5 * SCALE)   # 贴框外沿的偏移
        badge_cands = [
            (x1 - o - nw, y1 - o - nh),   # 左上外侧
            (x2 + o, y1 - o - nh),        # 右上外侧
            (x2 - nw + o, y1 - o - nh),   # 上中偏右
            (x1 - o - nw, y2 + o),        # 左下外侧
            (x1 + int(3 * SCALE), y1 + int(3 * SCALE)),  # 框内左上（兜底）
        ]
        badge = None
        for c in badge_cands:
            r = (c[0], c[1], c[0] + nw, c[1] + nh)
            if c is badge_cands[-1]:
                badge = r
                break
            if free(r, i):
                badge = r
                break
        used.append(badge)
        draw.rounded_rectangle(badge, radius=int(nh / 2.6), fill=color, outline=WHITE,
                               width=max(2, int(1.4 * SCALE)))
        draw.text((badge[0] + (nw - (nb[2] - nb[0])) / 2 - nb[0],
                   badge[1] + (nh - (nb[3] - nb[1])) / 2 - nb[1]), num, font=f_num, fill=WHITE)

        # ---- 文字标签（气泡）
        label = b["label"]
        tb = draw.textbbox((0, 0), label, font=f_txt)
        tw, th = tb[2] - tb[0], tb[3] - tb[1]
        pad = int(5.5 * SCALE)
        bw, bh = tw + pad * 2, th + pad * 2
        gap = int(6 * SCALE)
        left = x1 - bw - gap
        right = x2 + gap
        above = y1 - bh - gap - int(16 * SCALE)
        below = y2 + gap
        cands = [
            (right, y1 - int(2 * SCALE)),        # 右（侧栏/控件右侧空间最充裕）
            (left, y1 - int(2 * SCALE)),         # 左
            (x1, above),                         # 上
            (x1, below),                         # 下
            (right, below),                      # 右下
            (x2 - bw, above),                    # 上（右对齐）
        ]
        best = None
        for cx, cy in cands:
            r = (cx, cy, cx + bw, cy + bh)
            if free(r, i):
                best = r
                break
        if best is None:
            cx = min(max(4, right), W - bw - 4)
            cy = max(4, above)
            best = (cx, cy, cx + bw, cy + bh)
        used.append(best)
        draw.rounded_rectangle(best, radius=int(3 * SCALE), fill=WHITE, outline=color,
                               width=max(2, int(1.2 * SCALE)))
        draw.text((best[0] + pad - tb[0], best[1] + pad - tb[1]), label, font=f_txt, fill=color)

    # ---- 右下角水印
    wf = font(int(10.5 * SCALE))
    wm = "科研工作台 · 界面实拍（演示数据）"
    wb = draw.textbbox((0, 0), wm, font=wf)
    ww, wh = wb[2] - wb[0], wb[3] - wb[1]
    draw.rounded_rectangle([W - ww - 40, H - wh - 38, W - 14, H - 12], radius=int(3 * SCALE),
                           fill=(255, 255, 255), outline=(228, 224, 216), width=2)
    draw.text((W - ww - 27, H - wh - 25), wm, font=wf, fill=(130, 126, 118))

    im.save(SHOTS / f"{name}-annotated.png", optimize=True)
    print("annotated", name, len(data["boxes"]))


meta = json.load(open(SHOTS / "boxes.json", encoding="utf-8"))
for name, data in meta.items():
    if (SHOTS / f"{name}.png").exists():
        process(name, data)
print("done")
