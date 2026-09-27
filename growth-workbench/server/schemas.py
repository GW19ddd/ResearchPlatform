"""跨模块复用的 pydantic 模型与字段约束。

路由层的入参模型集中在这里，避免同一个「1-5 分」「正整数」约束在六个文件里各写一遍、
还写得不一致（有的地方根本没约束）。
"""
from typing import Annotated

from pydantic import BaseModel, Field

Score = Annotated[int, Field(ge=1, le=5)]
NonNegInt = Annotated[int, Field(ge=0)]
PosInt = Annotated[int, Field(gt=0)]


class OkOut(BaseModel):
    ok: bool = True
