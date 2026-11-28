"""工作台的出网名单（deploy/workbench/firewall.py，#498）：名单从哪些变量来、写错了怎么报、
规则长什么样、地址留多久、启动时先写规则再应答就绪。
真的写规则、连不连得通在 compose 冒烟里（scripts/release/compose-smoke.sh）。"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "deploy" / "workbench" / "firewall.py"
spec = importlib.util.spec_from_file_location("firewall", SCRIPT)
assert spec is not None and spec.loader is not None
firewall = importlib.util.module_from_spec(spec)
sys.modules["firewall"] = firewall
spec.loader.exec_module(firewall)
Entry = firewall.Entry

OFFICIAL = [
    Entry(h, 443, cdn=True) for h in (*firewall.OFFICIAL_PYPI, *firewall.OFFICIAL_GITHUB_RELEASE)
]
NO_MIRRORS = {"SFLY_PYPI_MIRROR": "file:///p", "SFLY_GITHUB_RELEASE_MIRROR": "file:///g"}


def pairs(entries: list[object]) -> list[tuple[str, int, bool]]:
    return [(e.host, e.port, e.cdn) for e in entries]  # type: ignore[attr-defined]


def test_control_plane_and_mirrors_are_allowed_and_nothing_else() -> None:
    env = {
        "SFLY_WORKBENCH_URL": "http://sfly:8080",
        "SFLY_PUBLIC_URL": "https://sfly.example.com",
        "SFLY_PUBLIC_GRPC_URL": "http://sfly.example.com:50051",
        "SFLY_PYPI_MIRROR": "https://user:pw@mirrors.example.com/pypi/simple",
        "SFLY_GITHUB_RELEASE_MIRROR": "http://mirror.internal:8000/github-release",
        "SFLY_PYTHON_INSTALL_MIRROR": "https://python.example.net/standalone/",
    }
    # 包镜像标成 cdn（放行一小时内解析到过的地址），控制面不是。
    assert pairs(firewall.allowlist(env)) == [
        ("mirror.internal", 8000, True),
        ("mirrors.example.com", 443, True),
        ("python.example.net", 443, True),
        ("sfly", 8080, False),
        ("sfly.example.com", 443, False),
        ("sfly.example.com", 50051, False),
    ]


def test_without_a_grpc_url_the_gateway_is_the_public_host_on_50051() -> None:
    env = {
        "SFLY_WORKBENCH_URL": "http://sfly:8080",
        "SFLY_PUBLIC_URL": "http://sfly.example.com:8080",
        **NO_MIRRORS,
        "SFLY_PYPI_MIRROR": "/srv/pypi/simple",
        "SFLY_PYTHON_INSTALL_MIRROR": "FILE:///srv/python",
    }
    # file:// 和绝对路径（uv 的 --default-index 认）的镜像不出网，不放行任何地址。
    assert pairs(firewall.allowlist(env)) == [
        ("sfly", 8080, False),
        ("sfly.example.com", 8080, False),
        ("sfly.example.com", 50051, False),
    ]


def test_without_mirrors_uv_official_sources_are_allowed() -> None:
    allowed = firewall.allowlist({"SFLY_WORKBENCH_URL": "http://sfly:8080"})
    assert allowed == sorted({Entry("sfly", 8080), *OFFICIAL})


def test_extra_entries_are_host_port_pairs_separated_by_spaces_or_commas() -> None:
    env = {
        **NO_MIRRORS,
        "SFLY_WORKBENCH_EGRESS": " db.internal:5432,sut:9000  10.0.0.7:22 [fd00::1]:80 ",
    }
    assert pairs(firewall.allowlist(env)) == [
        ("10.0.0.7", 22, False),
        ("db.internal", 5432, False),
        ("fd00::1", 80, False),
        ("sut", 9000, False),
    ]


SECRET = "s3cr3t-marker"


@pytest.mark.parametrize(
    "bad",
    [
        "sut",
        "sut:",
        ":80",
        "sut:0",
        "sut:65536",
        "sut:http",
        "sut:٣",
        "https://mirror.example:443",
        f"{SECRET}@mirror.example:443",
        f"mirror.example/{SECRET}:443",
        f"[{SECRET}]:80",
    ],
)
def test_a_malformed_extra_entry_is_reported_by_position_without_its_value(bad: str) -> None:
    with pytest.raises(firewall.Invalid) as error:
        firewall.allowlist({**NO_MIRRORS, "SFLY_WORKBENCH_EGRESS": f"ok.internal:80 {bad}"})
    assert (
        str(error.value)
        == "SFLY_WORKBENCH_EGRESS 第 2 条：要写成「主机:端口」，端口在 1–65535 之间"
    )
    assert SECRET not in str(error.value) and "mirror" not in str(error.value)


@pytest.mark.parametrize(
    ("value", "reason"),
    [
        (
            f"ftp://{SECRET}@mirror.example/pypi",
            "要是 http://、https://、file:// 开头的地址或绝对路径",
        ),
        (f"mirror.example/{SECRET}", "要是 http://、https://、file:// 开头的地址或绝对路径"),
        (f"https://{SECRET}:pw@/pypi", "主机名写得不对"),
        (f"https://bad host/{SECRET}", "主机名写得不对"),
        (f"https://{SECRET}@mirror.example:99999/", "端口要在 1–65535 之间"),
        (f"https://{SECRET}@mirror.example:0/", "端口要在 1–65535 之间"),
    ],
)
@pytest.mark.parametrize(
    "name",
    [
        "SFLY_PUBLIC_URL",
        "SFLY_PYPI_MIRROR",
        "SFLY_GITHUB_RELEASE_MIRROR",
        "SFLY_PYTHON_INSTALL_MIRROR",
    ],
)
def test_a_malformed_url_is_reported_by_name_without_its_value(
    name: str, value: str, reason: str
) -> None:
    with pytest.raises(firewall.Invalid) as error:
        firewall.allowlist({name: value})
    assert str(error.value) == f"{name}：{reason}"


def test_main_prints_only_the_reason_and_exits_nonzero(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(firewall.os, "environ", {"SFLY_WORKBENCH_EGRESS": f"https://{SECRET}:443"})
    monkeypatch.setattr(firewall, "run", lambda *_: pytest.fail("名单写错了还在写规则"))
    assert firewall.main() == 1
    out = capsys.readouterr()
    assert SECRET not in out.out + out.err
    assert "SFLY_WORKBENCH_EGRESS 第 1 条" in out.err


def test_rules_drop_by_default_and_accept_loopback_replies_and_the_allowlist() -> None:
    rules = firewall.ipv4_rules({("172.18.0.3", 8080), ("10.0.0.7", 22)}).splitlines()
    assert rules == [
        "*filter",
        ":OUTPUT DROP [0:0]",
        "-A OUTPUT -o lo -j ACCEPT",
        "-A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
        "-A OUTPUT -p tcp -d 10.0.0.7 --dport 22 -j ACCEPT",
        "-A OUTPUT -p tcp -d 172.18.0.3 --dport 8080 -j ACCEPT",
        "-A OUTPUT -p tcp -j REJECT --reject-with tcp-reset",
        "-A OUTPUT -j REJECT --reject-with icmp-port-unreachable",
        "COMMIT",
    ]
    assert ":OUTPUT DROP [0:0]" in firewall.IPV6_RULES
    assert "-A OUTPUT -p tcp -j REJECT --reject-with tcp-reset" in firewall.IPV6_RULES


class Lookup:
    def __init__(self, answers: dict[str, set[str]]) -> None:
        self.answers = answers

    def __call__(self, host: str, port: int) -> set[str]:
        if host not in self.answers:
            raise OSError("没有这个主机")
        return set(self.answers[host])


def test_mirror_addresses_seen_within_an_hour_stay_allowed_and_older_ones_expire() -> None:
    lookup = Lookup({"cdn.example.com": {"1.1.1.1"}})
    now = [0.0]
    wall = firewall.Firewall([Entry("cdn.example.com", 443, cdn=True)], lookup, lambda: now[0])
    assert wall.allowed() == {("1.1.1.1", 443)}

    lookup.answers["cdn.example.com"] = {"2.2.2.2"}
    now[0] = 1800
    assert wall.allowed() == {("1.1.1.1", 443), ("2.2.2.2", 443)}

    now[0] = 3601 + 1800
    lookup.answers["cdn.example.com"] = {"3.3.3.3"}
    assert wall.allowed() == {("3.3.3.3", 443)}


def test_control_plane_and_listed_addresses_follow_the_current_resolution_only() -> None:
    lookup = Lookup({"sfly": {"172.18.0.3"}, "sut": {"172.18.0.9"}})
    now = [0.0]
    wall = firewall.Firewall([Entry("sfly", 8080), Entry("sut", 9000)], lookup, lambda: now[0])
    assert wall.allowed() == {("172.18.0.3", 8080), ("172.18.0.9", 9000)}

    # 容器重建换了地址：旧地址马上不放行（它可能分给了别的服务）。
    lookup.answers = {"sfly": {"172.18.0.4"}, "sut": {"172.18.0.10"}}
    now[0] = 60
    assert wall.allowed() == {("172.18.0.4", 8080), ("172.18.0.10", 9000)}

    # 解析失败（DNS 一时不通）：沿用上一次解析到的，不是全拒。
    lookup.answers = {"sut": {"172.18.0.10"}}
    now[0] = 120
    assert wall.allowed() == {("172.18.0.4", 8080), ("172.18.0.10", 9000)}


def test_startup_writes_deny_rules_then_the_allowlist_and_only_then_answers_ready() -> None:
    events: list[str] = []
    lookup = Lookup({"sfly": {"172.18.0.3"}})

    def resolving(host: str, port: int) -> set[str]:
        events.append(f"resolve {host}")
        return lookup(host, port)

    def write(command: str, rules: str) -> None:
        allowed = [line for line in rules.splitlines() if "--dport" in line]
        events.append(f"{command} {len(allowed)}")

    wall = firewall.Firewall([Entry("sfly", 8080)], resolving)
    firewall.run(
        wall, write, lambda: events.append("ready"), lambda _: events.append("wait"), rounds=1
    )
    assert events == [
        # 两种地址族先只放行回环（解析名单要时间，这期间什么也出不去）。
        "ip6tables-restore 0",
        "iptables-restore 0",
        "resolve sfly",
        "iptables-restore 1",
        # 完整的规则写好之后才应答就绪；工作台入口等的就是它。
        "ready",
        "wait",
        "resolve sfly",
        "iptables-restore 1",
    ]


def test_a_failing_rule_write_never_answers_ready() -> None:
    def write(command: str, rules: str) -> None:
        raise firewall.subprocess.CalledProcessError(1, command)

    ready: list[str] = []
    with pytest.raises(firewall.subprocess.CalledProcessError):
        firewall.run(firewall.Firewall([]), write, lambda: ready.append("ready"), rounds=0)
    assert ready == []
