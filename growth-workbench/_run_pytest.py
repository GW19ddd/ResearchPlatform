import contextlib
import sys
from pathlib import Path

ROOT = Path(r"D:/03-Codes/2026-09-20-01-46-40")
SERVER = ROOT / "growth-workbench" / "server"
sys.path.insert(0, str(SERVER))

import pytest  # noqa: E402


class Buf:
    def __init__(self):
        self.parts = []

    def write(self, s):
        self.parts.append(s)

    def flush(self):
        pass

    def isatty(self):
        return False

    def getvalue(self):
        return "".join(self.parts)


target = sys.argv[1] if len(sys.argv) > 1 else str(SERVER / "tests")
args = [target, "-q", "--tb=line",
        "--basetemp", str(ROOT / "growth-workbench" / ".pytest_tmp"),
        "-p", "no:cacheprovider"] + sys.argv[2:]
buf = Buf()
with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
    rc = pytest.main(args)
(ROOT / "rpt-003.txt").write_text(buf.getvalue() + f"\nRC={rc}\n", encoding="utf-8")
