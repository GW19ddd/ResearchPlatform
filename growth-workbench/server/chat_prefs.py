"""对话框偏好 → 本轮 system 片段 / 模型覆盖。

前端 features/chat/prefs.ts 把审批模式、模型、工作区与附件随每个聊天请求发来
（chatEnvelope()）。这里做两件事：

  1. 归一化 + 夹断长度（附件正文可能很长，绝不撑爆 prompt）
  2. 生成一段「本轮运行环境」注入 system，让偏好真的对这一轮生效

边界（重要，别误读）：
  - 审批模式目前是**软约束 + 请求留痕**，不是命令执行闸门。
    expagent.py 的 subprocess.run 没有任何前置审批，这里也不改它；
    要真正拦住危险命令，需要另做「挂起 → 用户确认 → 继续」的交互。
  - 模型覆盖只替换本轮模型名，档位仍由 llm.FORCE_FAST 统一 fast。
"""
from __future__ import annotations

from pydantic import BaseModel

MAX_ATTACH_CHARS = 6000
MAX_TOTAL_CHARS = 24000
MAX_FILES = 60
MAX_MODEL_LEN = 120


class ChatPrefsIn(BaseModel):
    """所有聊天请求体共用的可选字段；不带时行为与改动前完全一致。"""

    approval_mode: str | None = None  # ask | full
    model: str | None = None  # '' 或 None = 跟随全局设置
    workspace: dict | None = None  # {name, branch, worktree}
    attachments: list[dict] | None = None  # [{name, size, text}]
    workspace_files: list[str] | None = None


def as_dict(body) -> dict:
    if isinstance(body, dict):
        return body
    if hasattr(body, "model_dump"):
        return body.model_dump()
    return {}


def model_override(body) -> str | None:
    """用户在本轮下拉里选的模型名；空串表示跟随全局设置。"""
    m = str(as_dict(body).get("model") or "").strip()
    return m[:MAX_MODEL_LEN] or None


def system_from(body) -> str:
    """拼一段可直接追加到 system 的说明；没有任何偏好时返回空串。"""
    d = as_dict(body)
    lines: list[str] = []

    approval = str(d.get("approval_mode") or "").strip()
    if approval == "ask":
        lines.append(
            "代理操作批准方式：由我批准。涉及删除文件、安装依赖、访问远程资源或执行本机命令时，"
            "先列出准备执行的操作与理由，等用户明确确认后再给完整步骤；确认前不要声称操作已完成。"
        )
    elif approval == "full":
        lines.append("代理操作批准方式：完全访问。用户已授权直接给出完整方案与命令，无需逐步确认。")

    ws = d.get("workspace") or {}
    if isinstance(ws, dict):
        bits = [str(ws.get(k) or "").strip()[:80] for k in ("name", "branch")]
        parts = [x for x in bits if x]
        if ws.get("worktree"):
            parts.append("worktree 开启")
        if parts:
            lines.append("当前工作区上下文：" + " / ".join(parts))

    budget = MAX_TOTAL_CHARS
    atts = d.get("attachments") or []
    if isinstance(atts, list) and atts:
        blocks: list[str] = []
        for a in atts[:12]:
            if not isinstance(a, dict):
                continue
            name = str(a.get("name") or "").strip()[:120]
            if not name:
                continue
            text = str(a.get("text") or "")[: min(MAX_ATTACH_CHARS, budget)]
            budget -= len(text)
            blocks.append(f"--- {name} ---\n{text}" if text else f"--- {name} ---（非文本文件，仅提供文件名）")
            if budget <= 0:
                break
        if blocks:
            lines.append("本轮附件（用户实际提供的内容，可直接引用，不要臆造其它文件）：\n" + "\n".join(blocks))

    files = d.get("workspace_files") or []
    if isinstance(files, list) and files:
        names = [str(f).strip()[:160] for f in files[:MAX_FILES] if str(f).strip()]
        if names:
            lines.append("用户选择的文件夹文件树（仅路径，未读取内容）：\n" + "\n".join("- " + n for n in names))

    if not lines:
        return ""
    return "\n\n【本轮运行环境】\n" + "\n".join(lines)
