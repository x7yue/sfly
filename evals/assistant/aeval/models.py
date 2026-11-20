"""评测用的模型（模型配置，见 `models_path`），
以及据此给容器里的 pi 生成的 `~/.pi/agent/models.json`。

容器里的 pi 只知道一个提供方 `aeval`，指向这个模型的 endpoint；`apiKey` 是占位值，
真正的凭据由宿主机的转发口在转发时加上（aeval.model_proxy），不进容器。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from aeval.env import DATA_HOME, EVALS_DIR

PROVIDER = "aeval"
PLACEHOLDER_KEY = "aeval-no-key"


@dataclass(frozen=True)
class Model:
    name: str
    spec: dict[str, Any]

    @property
    def model_id(self) -> str:
        return str(self.spec["model"])

    @property
    def thinking(self) -> str | None:
        value = self.spec.get("thinking")
        return str(value) if value else None

    @property
    def tier(self) -> str:
        return str(self.spec.get("tier", ""))

    def pi_models_json(self) -> dict[str, Any]:
        model: dict[str, Any] = {
            "id": self.model_id,
            "name": self.name,
            "reasoning": bool(self.spec.get("reasoning", False)),
            "input": ["text"],
            "contextWindow": int(self.spec["contextWindow"]),
            "maxTokens": int(self.spec["maxTokens"]),
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        }
        if "thinkingLevelMap" in self.spec:
            model["thinkingLevelMap"] = self.spec["thinkingLevelMap"]
        provider: dict[str, Any] = {
            "name": "评测",
            "baseUrl": self.spec["endpoint"],
            "api": self.spec["api"],
            "apiKey": PLACEHOLDER_KEY,
            "models": [model],
        }
        if "compat" in self.spec:
            provider["compat"] = self.spec["compat"]
        return {"providers": {PROVIDER: provider}}


# 假的模型端点（container/fake_model.py）：只验证流程，离线包和断网验证都用它，所以内置。
FAKE: dict[str, Any] = {
    "tier": "假的模型端点（只验证流程）",
    "api": "openai-completions",
    "endpoint": "http://fake-model.internal:8100/v1",
    "model": "fake",
    "contextWindow": 128000,
    "maxTokens": 8192,
    "reasoning": False,
    "toolCalls": True,
}


def models_path() -> Path:
    """真实的模型配置在仓库之外（仓库是公开的）。

    依次找：AEVAL_MODELS，~/.local/share/sfly/evals/models.json，都没有时用仓库里的示例。
    """
    explicit = os.environ.get("AEVAL_MODELS")
    if explicit:
        return Path(explicit)
    private = DATA_HOME / "models.json"
    return private if private.exists() else EVALS_DIR / "models.example.json"


def load_models(path: Path | None = None) -> dict[str, Model]:
    data = json.loads((path or models_path()).read_text())
    models = {name: Model(name, spec) for name, spec in data["models"].items()}
    models.setdefault("fake", Model("fake", FAKE))
    return models
