"""技能市场的离线测试：不碰网络，不碰真实 skills/github 目录。

重点验证两件容易出错、又很难在 UI 上发现的事：
  1. 稀疏下载只落盘命中目录，二进制与大文件不写（否则用户磁盘会被 evals/ 塞满）
  2. 单目录安装后不留多余层级（否则 skill_fs 扫出来的 rel 路径全错，节点标题变垃圾）
"""
import io
import os
import shutil
import sys
import tarfile
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import skill_market  # noqa: E402


def make_tarball(root: str = "myrepo-main") -> bytes:
    buf = io.BytesIO()

    def add(tf, name, data: bytes):
        ti = tarfile.TarInfo(f"{root}/{name}")
        ti.size = len(data)
        tf.addfile(ti, io.BytesIO(data))

    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        add(tf, "README.md", b"# big repo")
        add(tf, "skills/a/SKILL.md", b"---\nname: alpha\ndescription: A skill\n---\nbody A")
        add(tf, "skills/a/references/ref.md", b"ref a")
        add(tf, "skills/b/SKILL.md", b"---\nname: beta\ndescription: B skill\n---\nbody B")
        add(tf, "evals/huge/data.json", b"x" * 5000)
        add(tf, "assets/pic.png", b"\x89PNG....")
    return buf.getvalue()


def test_extract_selected_dir_only():
    blob = make_tarball()
    with tempfile.TemporaryDirectory() as tmp:
        dest = os.path.join(tmp, "out")
        os.makedirs(dest)
        counter: dict = {}
        n = skill_market.extract_skills(blob, dest, {"skills/a"}, counter)
        files = sorted(
            os.path.relpath(os.path.join(r, f), dest).replace("\\", "/")
            for r, _d, fs in os.walk(dest)
            for f in fs
        )
        assert n == 2, f"应只写入 2 个文件，实际 {n}：{files}"
        # extract_skills 保留原相对路径（层级裁剪是 install 的活），所以这里带 skills/a/
        assert files == ["skills/a/SKILL.md", "skills/a/references/ref.md"], files
        assert counter["bytes"] == len(
            b"---\nname: alpha\ndescription: A skill\n---\nbody A"
        ) + len(b"ref a")
        print("  ok  extract_selected_dir_only:", files)


def test_extract_whole_repo_skips_binary():
    blob = make_tarball()
    with tempfile.TemporaryDirectory() as tmp:
        n = skill_market.extract_skills(blob, tmp, None)
        files = []
        for r, _d, fs in os.walk(tmp):
            files += [os.path.relpath(os.path.join(r, f), tmp).replace("\\", "/") for f in fs]
        assert not any(f.endswith(".png") for f in files), f"png 不该落盘：{files}"
        assert len(files) == n == 5, (n, files)
        print("  ok  extract_whole_repo_skips_binary:", sorted(files))


def test_install_single_dir_flattens():
    """只装 skills/a 时，目标是 repo 根，不该是 repo/skills/a。"""
    blob = make_tarball()
    real_dir = skill_market.__dict__.get("_GITHUB_DIR")
    tmp_gh = tempfile.mkdtemp()
    try:
        # 临时把 skills/github 指到沙箱
        import skill_fs

        old = skill_fs.GITHUB_DIR
        skill_fs.GITHUB_DIR = tmp_gh
        skill_market._scan_probe = None  # 占位，无实际用途
        r = skill_market.install("me", "myrepo", ["skills/a/SKILL.md"], tarball=blob)
        assert r.get("ok"), r
        assert os.path.isfile(os.path.join(tmp_gh, "myrepo", "SKILL.md")), os.listdir(
            os.path.join(tmp_gh, "myrepo")
        )
        assert not os.path.isdir(os.path.join(tmp_gh, "myrepo", "skills")), "不该留 skills/a 层级"
        print("  ok  install_single_dir_flattens:", r["message"])
    finally:
        skill_fs.GITHUB_DIR = old
        shutil.rmtree(tmp_gh, ignore_errors=True)


def test_parse_repo():
    cases = {
        "anthropics/skills": ("anthropics", "skills"),
        "https://github.com/anthropics/skills": ("anthropics", "skills"),
        "https://github.com/anthropics/skills.git": ("anthropics", "skills"),
        "git@github.com:anthropics/skills.git": ("anthropics", "skills"),
    }
    for raw, want in cases.items():
        got = skill_market.parse_repo(raw)
        assert got == want, (raw, got, want)
    for bad in ["", "just-a-name", "https://gitlab.com/a/b"]:
        assert skill_market.parse_repo(bad) is None, bad
    print("  ok  parse_repo (4 命中 / 3 拒绝)")


if __name__ == "__main__":
    fails = 0
    for fn in [
        test_parse_repo,
        test_extract_selected_dir_only,
        test_extract_whole_repo_skips_binary,
        test_install_single_dir_flattens,
    ]:
        try:
            fn()
        except AssertionError as exc:
            fails += 1
            print(f"  FAIL {fn.__name__}: {exc}")
    print("FAILED" if fails else "ALL PASSED")
    sys.exit(1 if fails else 0)
