"""运行相关命令共用的显示规则：状态用词、链和节点的写法、时间与时长、日志行、节点类型名。

用词与界面一致：运行和链的状态是 apps/web/src/lib/copy.ts 的 RUN_STATUS_LABEL，节点和任务的状态是
apps/web/src/lib/node-status.ts；名称为空的子流程写「未命名子流程」（packages/orchestration 的
chain-label.ts）。命令行里的 `链:节点` 都由这里写出、也由这里认回去，所以 `scenario show`、
`run show`、`run logs --node`、进度行里的写法互相对得上。节点的显示名称只跟在运行输出里的 `链:节点`
后面（摘要、进度行、`run show`、`run artifacts`），写成 `链:节点「显示名称」`；要拼进下一条命令的
`链:节点` 和 `run logs` 的每一行不带名称。`scenario show` 不是运行输出，节点写成
「显示名称（节点 ID）」（`name_with_id`）。
"""

from __future__ import annotations

import re
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from sfly.cli.client import SESSION_ID_ENV, ApiError, Client, segment
from sfly.cli.errors import CliError
from sfly.cli.removed_nodes import REMOVED_NODE_KINDS, removed_kind_label

# ---------------------------------------------------------------- 状态

# 运行和链的状态。「running」在运行上写运行中，在节点上写执行中，界面也是这样分的，所以是两张表。
RUN_STATUS_LABEL = {"running": "运行中", "success": "成功", "failed": "失败", "cancelled": "已取消"}

# 节点和任务（节点的一次尝试）的状态。
NODE_STATUS_LABEL = {
    "pending": "待执行",
    "queued": "排队中",
    "dispatched": "准备中",
    "running": "执行中",
    "waiting": "等待中",
    "success": "成功",
    "failed": "失败",
    "skipped": "已跳过",
    "cancelled": "已取消",
    "stopped": "已停止",
}


def run_status_label(status: str, *, cancelling: bool = False, forced: bool = False) -> str:
    """运行（或链）的状态；已请求取消、还没结束的写取消中（强制取消后是强制终止中），不写运行中。"""
    if status == "running" and cancelling:
        return "强制终止中" if forced else "取消中"
    return RUN_STATUS_LABEL.get(status, status)


def node_status_label(status: str) -> str:
    return NODE_STATUS_LABEL.get(status, status)


# ---------------------------------------------------------------- 链和节点

MAIN_CHAIN = "main"
UNNAMED_SUBFLOW = "未命名子流程"


def subflow_label(name: str) -> str:
    """子流程的显示名称。`name` 是去掉首尾空白的名称（没有名称字段的旧版本是入口节点 id），
    填了空名称时写「未命名子流程」。"""
    return name or UNNAMED_SUBFLOW


def chain_name(subflow: str | None) -> str:
    """链在命令行里的名字：主链（`subflow` 为 None）是 `main`，子流程是它的显示名称。"""
    return MAIN_CHAIN if subflow is None else subflow_label(subflow)


def chain_label(chain: Mapping[str, Any]) -> str:
    """运行里的一条链的名字（`name` 是控制面给的子流程名称，主链没有）。"""
    return chain_name(chain.get("name"))


@dataclass(frozen=True)
class NodeRef:
    """命令行里的节点，或节点的某一次尝试：`链:节点`，指定尝试时 `链:节点#尝试`。"""

    chain: str
    node: str
    attempt: int | None = None

    @property
    def label(self) -> str:
        """`链:节点`，不带尝试。"""
        return f"{self.chain}:{self.node}"

    def format(self, *, retried: bool = False) -> str:
        """指定了尝试，并且节点重试过（`retried`）或不是第 1 次尝试时，写成 `链:节点#尝试`；
        第一次就成功的节点不带 `#`。"""
        if self.attempt is not None and (retried or self.attempt > 1):
            return f"{self.label}#{self.attempt}"
        return self.label

    def match(self, text: str) -> bool:
        """用户写的 `text` 是不是在说这个节点（`链:节点`，所有尝试）或这次尝试（`链:节点#尝试`）。
        拿写出来的文字比较，不拆分：链名和节点 id 里都可能有 `:`、`#`。"""
        return text == self.label or (
            self.attempt is not None and text == f"{self.label}#{self.attempt}"
        )


def display_name_of(node: Mapping[str, Any]) -> dict[str, str]:
    """运行里的节点的显示名称，写进 `--json` 的输出：`{"display_name": 名称}`，没有时是空字典
    （不带这个键）。名称由控制面从运行绑定的场景版本里补上（没有、或就是节点 ID 时不给）。"""
    name = node.get("display_name")
    return {"display_name": name} if name else {}


def with_display_name(text: str, display_name: str | None) -> str:
    """运行输出（`run start --wait`、`run wait`、`run show`、`run artifacts`）里节点 ID 在前、
    显示名称在后：`main:create_user_1「创建测试用户」`；没有名称时原样。运行输出常被拿去拼下一条
    命令，所以和界面里「显示名称（节点 ID）」的顺序相反。`scenario show` 不是运行输出，写
    「显示名称（节点 ID）」，用 `name_with_id`；`run logs` 的每一行不带名称。"""
    return f"{text}「{display_name}」" if display_name else text


def name_with_id(node_id: str, display_name: str | None) -> str:
    """`scenario show` 里写节点的名字：「显示名称（节点 ID）」；没有名称、只有空白或名称就是
    节点 ID 时只写节点 ID（对应 TS 的 `nameWithId`）。运行输出的写法是 `with_display_name`，
    节点 ID 在前。"""
    name = (display_name or "").strip()
    return f"{name}（{node_id}）" if name and name != node_id else node_id


def last_attempt(node: Mapping[str, Any]) -> dict[str, Any] | None:
    attempts = node["attempts"]
    return max(attempts, key=lambda a: a["attempt"]) if attempts else None


# ---------------------------------------------------------------- 数字


def format_number(value: float) -> str:
    """指标和输出里的数：整数不带小数点也不用科学计数法，其余最多 6 位有效数字。"""
    if value == int(value) and abs(value) < 1e15:
        return str(int(value))
    return f"{value:.6g}"


# ---------------------------------------------------------------- 时间和时长


def parse_time(text: str) -> datetime:
    """控制面的时间戳（ISO 8601，以 Z 结尾）。"""
    parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def duration_ms(start: str | None, end: str | None) -> int | None:
    """两个控制面时间之间的毫秒数；缺任何一个时为 None。"""
    if not start or not end:
        return None
    return max(round((parse_time(end) - parse_time(start)).total_seconds() * 1000), 0)


def format_duration(ms: int | None) -> str:
    """`16ms`、`1.2s`、`12s`、`3m05s`、`1h02m`：不到 1 秒写毫秒，不到 10 秒保留一位小数。

    没有时为 `-`。命令行里的耗时都用它（`sfly run`、`sfly debug` 的动作）。
    """
    if ms is None:
        return "-"
    if ms < 1000:
        return f"{ms}ms"
    if ms < 10_000:
        return f"{ms / 1000:.1f}s"
    seconds = round(ms / 1000)
    if seconds < 60:
        return f"{seconds}s"
    minutes, rest = divmod(seconds, 60)
    if minutes < 60:
        return f"{minutes}m{rest:02d}s"
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h{minutes:02d}m"


# ---------------------------------------------------------------- 排队中的节点在等什么

# 排队中的节点最多列出几个占着槽位的任务，其余写「还有 N 个」。
_MAX_SLOT_HOLDERS = 3


def _holder_label(holder: Mapping[str, Any]) -> str:
    """占着槽位的任务：`撮合压测（运行 5e2d1c7a）的 main:soak「浸泡」`。
    写明是哪次运行：同一场景触发两次互相抢槽位时分得开。"""
    ref = NodeRef(chain_name(holder["chain_name"]), holder["node_id"]).label
    named = with_display_name(ref, holder.get("display_name"))
    return f"{holder['orchestration_name']}（运行 {holder['run_id'][:8]}）的 {named}"


def queue_wait_text(wait: Mapping[str, Any], queued_at: str) -> str:
    """排队中的节点在等什么（运行视图里排队中尝试的 `queue_wait`；时间按它的 `now`，控制面时间）：
    `等 agent-a（不在线，已离线 2m00s）· 排队 3m05s · 6m55s 后超时`；
    被管理员停用的 Agent 括号里写 `已停用 2m00s`（不写「不在线」）。

    和界面写法一致（apps/web/src/lib/copy.ts 的 `QUEUE_WAIT`，`test_cli_run_view.py` 检查）：
    括号里是这台 Agent 现在的情况；槽位占满时后面接占着槽位的任务（最多 3 个）；最后是排了多久
    和多久后排队超时（没有设置排队超时的只写排了多久，过了超时时间、控制面还没处理的写「即将超时」）。
    """
    now = parse_time(wait["now"])

    def since(text: str) -> str:
        return format_duration(max(round((now - parse_time(text)).total_seconds() * 1000), 0))

    state = wait["state"]
    if state == "disabled":
        situation = "已停用" if wait["since"] is None else f"已停用 {since(wait['since'])}"
    elif state == "offline":
        situation = "不在线" if wait["since"] is None else f"不在线，已离线 {since(wait['since'])}"
    elif state == "preparing":
        situation = "准备环境中" if wait["since"] is None else f"准备环境中 {since(wait['since'])}"
    elif state == "version_mismatch":
        situation = "版本与控制面不一致，不派新任务"
    elif state == "slots_full":
        situation = f"槽位占满，{wait['slots']} / {wait['slots']}"
    elif state == "dispatching":
        situation = "正在派发"
    else:
        # 比命令行新的控制面可能带没见过的状态：原样写出状态名，不猜成「正在派发」。
        situation = str(state)
    timing = [f"排队 {since(queued_at)}"]
    expires = wait["expires_at"]
    if expires is not None:
        left = round((parse_time(expires) - now).total_seconds() * 1000)
        timing.append(f"{format_duration(left)} 后超时" if left > 0 else "即将超时")
    # 全角括号后面的分隔不再加空格（和界面一致）。
    text = f"等 {wait['agent']}（{situation}）· " + " · ".join(timing)
    holders = wait["holders"]
    elsewhere = wait.get("other_project_holders", 0)
    if holders or elsewhere:
        shown = "、".join(_holder_label(h) for h in holders[:_MAX_SLOT_HOLDERS])
        more = len(holders) - _MAX_SLOT_HOLDERS
        rest = [f"还有 {more} 个"] if more > 0 else []
        # 同一台 Agent 上别的项目的任务只有个数，看不到它们的场景和运行（和界面一致）。
        if elsewhere:
            rest.append(f"{'另有' if shown else ''}别的项目的任务 {elsewhere} 个")
        text += "；占着槽位的任务：" + shown + ("，" if shown and rest else "") + "，".join(rest)
    return text


# ---------------------------------------------------------------- 日志行


def line_time(line: Mapping[str, Any]) -> str:
    """控制面时间；升级之前写入的行没有，退回当时记的 Agent 时间。"""
    return str(line["time"] or line.get("agent_time") or "-")


def format_log_line(line: Mapping[str, Any], label: str | None = None, *, indent: str = "") -> str:
    """`时间 级别 [链:节点] 内容`；内容有多行时，后面的行比第一行多缩进四格。
    `indent` 是整段日志缩进的格数（摘要里的日志缩在失败的任务下面）。"""
    first, *rest = str(line["text"]).rstrip("\n").split("\n")
    parts = [line_time(line), f"{line['level']:<5}", *([label] if label else []), first]
    return "\n".join([indent + " ".join(parts), *(f"{indent}    {more}".rstrip() for more in rest)])


# ---------------------------------------------------------------- 节点类型

# 内置节点在「节点类型」里的名称；包节点显示 `包名/节点名`。
_BUILTIN_TYPES = {
    "entry": "入口",
    "subflow_entry": "子流程入口",
    "async": "异步任务",
    "stop_subflow": "停止子流程",
}


def node_type_label(node: Mapping[str, Any]) -> str:
    """节点类型的名称：包节点是 `包名/节点名`，内置节点是中文名。`node` 是场景文档里的节点；
    只知道 `kind` 时（读不到场景版本）包节点写 `package`。已移除的种类（ADR 0028，历史版本和
    历史运行里还留着这种节点）写成 `已移除的节点类型 <种类名>`，和控制面的 `removedKindLabel` 一致；
    不认识的种类原样写种类名。"""
    kind = str(node["kind"])
    if kind == "package":
        return f"{node['package']}/{node['node']}" if "package" in node else kind
    if kind in REMOVED_NODE_KINDS:
        return removed_kind_label(kind)
    return _BUILTIN_TYPES.get(kind, kind)


# ---------------------------------------------------------------- 取运行


def run_not_found(run_id: str) -> CliError:
    return CliError("run_not_found", f"没有 id 是 {run_id} 的运行", next="sfly run list")


# 「最近一次运行」的写法：自己（昵称）触发的、开始得最晚的那一次。
LATEST_RUN = ("latest", "最近")
# 运行编号的前缀至少写几个字符：太短会匹配上太多运行。
MIN_RUN_PREFIX = 4
# 命令行里 `运行` 参数的说明（取消不接受 latest）。
RUN_HELP = (
    "运行 id，可以只写前缀（至少 4 个字符，不产生歧义时），或写 latest：自己触发的最近一次运行"
)
RUN_HELP_NO_LATEST = "运行 id，可以只写前缀（至少 4 个字符，不产生歧义时）；取消不接受 latest"
# 控制面还不认按触发人、按编号前缀筛的参数（比命令行旧）时，退回到取最近的一批运行再在这里筛：
# 最多要这么多个。
_RUN_LOOKUP_LIMIT = 500
# 前缀有歧义时最多列出多少个候选。
_MAX_AMBIGUOUS = 10
_RUN_PREFIX = re.compile(r"[0-9a-fA-F][0-9a-fA-F-]*")


def resolve_run(client: Client, ref: str, *, allow_latest: bool = True) -> str:
    """命令行里写的运行：完整的运行 id（原样返回）、运行 id 的前缀（至少 4 个字符，
    匹配到唯一一个运行时），或 `latest`（`最近`）：自己触发的、开始得最晚的一次
    （`allow_latest` 为 False 的命令不接受，例如取消）。返回完整的运行 id，之后的命令都用它，
    不用抄整段 UUID。

    找不到时抛 `run_not_found`；前缀匹配到几个运行时抛 `run_ambiguous`，列出每个候选的 id、场景、
    状态和开始时间；`latest` 一个也找不到时抛 `no_recent_run`。
    """
    text = ref.strip()
    if _is_uuid(text):
        return text
    if text.lower() in LATEST_RUN:
        if not allow_latest:
            raise CliError(
                "invalid_arguments",
                f"这条命令不接受 {text}：取消运行要写明是哪一次，用运行 id 或它的前缀",
                next="sfly run list",
            )
        return _latest_run(client)
    if not _RUN_PREFIX.fullmatch(text):
        raise run_not_found(ref)
    if len(text) < MIN_RUN_PREFIX:
        raise CliError(
            "run_prefix_too_short",
            f"运行编号的前缀至少写 {MIN_RUN_PREFIX} 个字符，收到 {text!r}：\n"
            "多写几位，或用完整的 id",
            next="sfly run list",
        )
    # 控制面按编号前缀筛（`id_prefix`）；比命令行旧的控制面不认它、返回最近的一批，
    # 所以这里仍然再筛一遍。
    listing = client.get("/runs", {"id_prefix": text, "limit": _RUN_LOOKUP_LIMIT})
    found = [r for r in listing["runs"] if str(r["id"]).lower().startswith(text.lower())]
    if not found:
        raise run_not_found(ref)
    if len(found) > 1:
        shown = [
            f"  {r['id']}  {r['orchestration_name']}  "
            f"{run_status_label(r['status'])}  {r['started_at']}"
            for r in found[:_MAX_AMBIGUOUS]
        ]
        if len(found) > _MAX_AMBIGUOUS:
            shown.append(f"  ……还有 {len(found) - _MAX_AMBIGUOUS} 个")
        raise CliError(
            "run_ambiguous",
            f"运行编号前缀 {text} 对应 {len(found)} 个运行，多写几位，或用完整的 id：\n"
            + "\n".join(shown),
            next="sfly run list",
        )
    return str(found[0]["id"])


def _latest_run(client: Client) -> str:
    if client.session_token:
        return _latest_in_session(client)
    # 「自己」是 `client.owner_name()`：有令牌时是令牌所属用户的显示名（控制面记在运行上的触发人），
    # 没有令牌时是昵称（昵称不校验，谁都能写别人的昵称；强制鉴权之后只剩令牌，#494）。
    owner = client.owner_name()
    listing = client.get("/runs", {"triggered_by": owner, "limit": 1})
    mine = [r for r in listing["runs"] if r["triggered_by"] == owner]
    if listing["runs"] and not mine:
        # 控制面不认 `triggered_by`（比命令行旧），返回的是别人的最近一次：
        # 退回到按关键字取一批再筛。
        # `q` 是包含匹配（昵称是别人昵称的一部分时也会返回），只要触发人就是自己的。
        listing = client.get("/runs", {"q": owner, "limit": _RUN_LOOKUP_LIMIT})
        mine = [r for r in listing["runs"] if r["triggered_by"] == owner]
    if not mine:
        raise CliError(
            "no_recent_run",
            f"没有找到 {owner} 触发过的运行（latest 指自己触发的最近一次；"
            "没有登录时「自己」是昵称，用 --nickname 或 SFLY_NICKNAME 指定，登录之后是登录的用户）",
            next="sfly run list",
        )
    return str(mine[0]["id"])


def _latest_in_session(client: Client) -> str:
    # 会话令牌代发起人干活：「自己触发的」是这个会话触发的（#787）。
    session = client.session_id
    if session is None:
        raise CliError(
            "session_id_missing",
            "这是会话令牌，latest 指这个会话触发的最近一次运行，"
            f"要用环境变量 {SESSION_ID_ENV} 写明是哪个会话（平台的工作台上已经设好）；"
            "或者给出运行的 id",
            next="sfly run list",
        )
    listing = client.get("/runs", {"session_id": session, "limit": 1})
    # 比命令行旧的控制面不认 `session_id`，返回的是项目里最近的一次：只认这个会话的。
    mine = [r for r in listing["runs"] if (r.get("session") or {}).get("id") == session]
    if not mine:
        raise CliError(
            "no_recent_run",
            f"这个会话（{session}）还没有触发过运行（会话令牌下 latest 指这个会话触发的最近一次）",
            next="sfly run list",
        )
    return str(mine[0]["id"])


def _is_uuid(text: str) -> bool:
    try:
        uuid.UUID(text)
    except ValueError:
        return False
    return len(text) == 36


def fetch_run(client: Client, run_id: str) -> dict[str, Any]:
    """运行详情；运行不存在时抛 `run_not_found`。"""
    try:
        run: dict[str, Any] = client.get(f"/runs/{segment(run_id)}")
    except ApiError as error:
        if error.status != 404:
            raise
        raise run_not_found(run_id) from None
    return run
