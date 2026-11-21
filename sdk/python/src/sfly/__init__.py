"""sfly 节点 SDK 运行时。只能使用 Python 标准库（ADR 0002）。"""

from sfly import feishu
from sfly.capabilities import (
    Agent,
    AgentError,
    AgentFileMoved,
    AgentFileNotFound,
    AgentNotReferenced,
    AgentPermissionDenied,
    AgentTimeout,
    AgentUnreachable,
    AgentUnsupported,
    FileEvent,
    FileId,
    FileInfo,
    WatchSnapshot,
)
from sfly.context import ArtifactDownloadError, Cancelled, Context, TaskInfo
from sfly.nodes import AgentName, Chart, Doc, FeishuBot, Metric, node
from sfly.run_state import (
    RunState,
    RunStateCancel,
    RunStateChain,
    RunStateError,
    RunStateNode,
    RunStateScenario,
    RunStateSelf,
)

__version__ = "0.5.0"

__all__ = [
    "Agent",
    "AgentError",
    "AgentFileMoved",
    "AgentFileNotFound",
    "AgentName",
    "AgentNotReferenced",
    "AgentPermissionDenied",
    "AgentTimeout",
    "AgentUnreachable",
    "AgentUnsupported",
    "ArtifactDownloadError",
    "Cancelled",
    "Chart",
    "Context",
    "Doc",
    "FeishuBot",
    "FileEvent",
    "FileId",
    "FileInfo",
    "Metric",
    "RunState",
    "RunStateCancel",
    "RunStateChain",
    "RunStateError",
    "RunStateNode",
    "RunStateScenario",
    "RunStateSelf",
    "TaskInfo",
    "WatchSnapshot",
    "__version__",
    "feishu",
    "node",
]
