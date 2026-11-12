"""
鸢尾花 K-Means 聚类完整演示（无需 sklearn）
==========================================
1. 从分析工作区读取 Fisher 鸢尾花数据集（150 x 5）
2. 从零实现 K-Means（k=3，k-means++ 初始化，多轮重启取最优）
3. PCA 把 4 维特征投影到 2 维用于可视化（也手写，协方差矩阵特征分解）
4. 输出：聚类中心 / 与真实物种的交叉表 / 聚类准确率 / PCA 散点图 PNG

产物：iris_kmeans_pca.png
"""
import csv
import random
import sys

sys.stdout.reconfigure(encoding="utf-8")  # 工作台按 UTF-8 读取 stdout，Windows 默认 cp936 会乱码
from collections import Counter
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

# ---------------------------------------------------------------- 路径：脚本与数据集同在 code 工作区，
# 鸢尾花数据在 analysis 工作区（data/workspace/analysis/default/），跨 kind 相对引用
HERE = Path(__file__).resolve().parent
CSV = HERE.parent.parent / "analysis" / "default" / "iris_fisher_1936.csv"
OUT_PNG = HERE / "iris_kmeans_pca.png"
K = 3
SEED = 42
RESTARTS = 8


# ---------------------------------------------------------------- 数据加载
def load_iris(path: Path):
    X, y = [], []
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            X.append([float(row[c]) for c in
                      ("sepal_length", "sepal_width", "petal_length", "petal_width")])
            y.append(row["species"])
    return X, y


# ---------------------------------------------------------------- 手写 K-Means（k-means++ 初始化）
def dist2(a, b):
    return sum((x - z) ** 2 for x, z in zip(a, b))


def kmeans_pp_init(X, k, rng):
    """k-means++：逐个以 D(x)^2 为权重抽样，避免坏初始中心。"""
    centers = [rng.choice(X)]
    while len(centers) < k:
        weights = [min(dist2(x, c) for c in centers) for x in X]
        total = sum(weights)
        r, acc = rng.random() * total, 0.0
        for x, w in zip(X, weights):
            acc += w
            if acc >= r:
                centers.append(x)
                break
    return centers


def kmeans(X, k, rng, max_iter=100, tol=1e-6):
    centers = kmeans_pp_init(X, k, rng)
    labels = [0] * len(X)
    for _ in range(max_iter):
        # 分配步：每个点归到最近中心
        labels = [min(range(k), key=lambda j: dist2(x, centers[j])) for x in X]
        # 更新步：中心取簇均值
        new_centers = []
        for j in range(k):
            members = [x for x, g in zip(X, labels) if g == j]
            if not members:  # 空簇：从最远点重生
                far = max(range(len(X)), key=lambda i: min(dist2(X[i], c) for c in centers))
                new_centers.append(X[far])
            else:
                new_centers.append([sum(col) / len(members) for col in zip(*members)])
        if sum(dist2(a, b) for a, b in zip(centers, new_centers)) < tol:
            centers = new_centers
            break
        centers = new_centers
    inertia = sum(dist2(x, centers[g]) for x, g in zip(X, labels))
    return centers, labels, inertia


def best_kmeans(X, k, restarts, seed):
    """多轮重启取 inertia 最小的一组，抗局部最优。"""
    rng = random.Random(seed)
    best = None
    for _ in range(restarts):
        c, l, s = kmeans(X, k, rng)
        if best is None or s < best[2]:
            best = (c, l, s)
    return best


# ---------------------------------------------------------------- 手写 PCA（2 维）
def pca_2d(X):
    n, d = len(X), len(X[0])
    mean = [sum(col) / n for col in zip(*X)]
    Xc = [[x - m for x, m in zip(row, mean)] for row in X]
    cov = [[sum(Xc[i][a] * Xc[i][b] for i in range(n)) / (n - 1)
            for b in range(d)] for a in range(d)]
    # 对称矩阵 Jacobi 旋转求特征值/特征向量
    A = [row[:] for row in cov]
    V = [[1.0 if i == j else 0.0 for j in range(d)] for i in range(d)]
    for _ in range(100):
        off = max(((abs(A[i][j]), i, j) for i in range(d) for j in range(i + 1, d)))
        if off[0] < 1e-10:
            break
        _, p, q = off
        if abs(A[p][q]) < 1e-30:
            continue
        phi = 0.5 * (A[q][q] - A[p][p]) / A[p][q]
        t = (1 if phi >= 0 else -1) / (abs(phi) + (phi * phi + 1) ** 0.5)
        c, s = 1 / (t * t + 1) ** 0.5, t / (t * t + 1) ** 0.5
        for r in range(d):
            Ap, Aq = A[p][r], A[q][r]
            A[p][r], A[q][r] = c * Ap - s * Aq, s * Ap + c * Aq
        for r in range(d):
            Ap, Aq = A[r][p], A[r][q]
            A[r][p], A[r][q] = c * Ap - s * Aq, s * Ap + c * Aq
        for r in range(d):
            Vp, Vq = V[r][p], V[r][q]
            V[r][p], V[r][q] = c * Vp - s * Vq, s * Vp + c * Vq
    eig = sorted(range(d), key=lambda i: -A[i][i])[:2]
    P = [[V[r][e] for e in eig] for r in range(d)]
    return [[sum(Xc[i][r] * P[r][j] for r in range(d)) for j in range(2)] for i in range(n)], mean


# ---------------------------------------------------------------- 评估
def purity(y_true, y_pred, k):
    """多数投票对齐后计算准确率：每个簇取出现最多的真实标签。"""
    mapping = {}
    for j in range(k):
        members = [t for t, p in zip(y_true, y_pred) if p == j]
        mapping[j] = Counter(members).most_common(1)[0][0] if members else "?"
    correct = sum(1 for t, p in zip(y_true, y_pred) if mapping[p] == t)
    return correct / len(y_true), mapping


# ---------------------------------------------------------------- main
def main():
    X, y = load_iris(CSV)
    print(f"数据集：{CSV.name}  样本 {len(X)}  维度 {len(X[0])}")

    centers, labels, inertia = best_kmeans(X, K, RESTARTS, SEED)
    print(f"K-Means(k={K}, 重启 {RESTARTS} 次)：inertia={inertia:.3f}")

    acc, mapping = purity(y, labels, K)
    print("簇 -> 物种对齐：", {f"cluster{j}": s for j, s in mapping.items()})
    print(f"多数投票对齐后的聚类准确率：{acc:.1%}")

    print("\n交叉表（行=预测簇，列=真实物种）：")
    species = sorted(set(y))
    header = f"{'cluster':>8} | " + " | ".join(f"{s:>10}" for s in species)
    print(header)
    print("-" * len(header))
    for j in range(K):
        cnt = Counter(t for t, p in zip(y, labels) if p == j)
        print(f"{('c' + str(j) + '(' + mapping[j][:4] + ')'):>8} | "
              + " | ".join(f"{cnt.get(s, 0):>10}" for s in species))

    # PCA 2 维散点：左=真实物种，右=K-Means 聚类（簇编号对齐颜色）
    Z, _ = pca_2d(X)
    colors = ["#4285f4", "#ea4335", "#fbbc04"]
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.5))
    # style 元素 = (匹配值, 颜色, 图例名)
    panels = [
        (y, [(sp, colors[species.index(sp)], sp) for sp in species],
         "Ground truth (species)"),
        (labels, [(j, colors[j], f"cluster {j}") for j in range(K)],
         "K-Means clusters"),
    ]
    for ax, (vals, style, title) in zip(axes, panels):
        for match, col, legend in style:
            xs = [Z[i][0] for i in range(len(Z)) if vals[i] == match]
            ys = [Z[i][1] for i in range(len(Z)) if vals[i] == match]
            ax.scatter(xs, ys, c=col, s=18, alpha=0.75, label=legend)
        ax.set_title(title)
        ax.set_xlabel("PC1")
        ax.set_ylabel("PC2")
        ax.legend(fontsize=8)
        ax.grid(alpha=0.25)
    fig.suptitle("Fisher Iris: K-Means (from scratch) vs ground truth, PCA 2D")
    fig.tight_layout()
    fig.savefig(OUT_PNG, dpi=140)
    plt.close(fig)
    print(f"\n图已保存：{OUT_PNG.name}")


if __name__ == "__main__":
    main()
