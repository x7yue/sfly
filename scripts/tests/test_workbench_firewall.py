"""工作台的出网名单（deploy/workbench/firewall.py，#498）：名单从哪些变量来、规则长什么样、地址留多久。
真的写规则、连不连得通在 compose 冒烟里（scripts/release/compose-smoke.sh）。"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "deploy" / "workbench" / "firewall.py"
spec = importlib.util.spec_from_file_location("firewall", SCRIPT)
assert spec is not None and spec.loader is not None
firewall = importlib.util.module_from_spec(spec)
spec.loader.exec_module(firewall)

OFFICIAL = [firewall.entry(e) for e in (*firewall.OFFICIAL_PYPI, *firewall.OFFICIAL_GITHUB_RELEASE)]


def test_control_plane_and_mirrors_are_allowed_and_nothing_else() -> None:
    env = {
        "SFLY_WORKBENCH_URL": "http://sfly:8080",
        "SFLY_PUBLIC_URL": "https://sfly.example.com",
        "SFLY_PUBLIC_GRPC_URL": "http://sfly.example.com:50051",
        "SFLY_PYPI_MIRROR": "https://user:pw@mirrors.example.com/pypi/simple",
        "SFLY_GITHUB_RELEASE_MIRROR": "http://mirror.internal:8000/github-release",
    }
    assert firewall.allowlist(env) == [
        ("mirror.internal", 8000),
        ("mirrors.example.com", 443),
        ("sfly", 8080),
        ("sfly.example.com", 443),
        ("sfly.example.com", 50051),
    ]


def test_without_a_grpc_url_the_gateway_is_the_public_host_on_50051() -> None:
    env = {
        "SFLY_WORKBENCH_URL": "http://sfly:8080",
        "SFLY_PUBLIC_URL": "http://sfly.example.com:8080",
        "SFLY_PYPI_MIRROR": "file:///srv/pypi",
        "SFLY_GITHUB_RELEASE_MIRROR": "file:///srv/github",
    }
    # file:// 的镜像不出网，不放行任何地址。
    assert firewall.allowlist(env) == [
        ("sfly", 8080),
        ("sfly.example.com", 8080),
        ("sfly.example.com", 50051),
    ]


def test_without_mirrors_uv_official_sources_are_allowed() -> None:
    allowed = firewall.allowlist({"SFLY_WORKBENCH_URL": "http://sfly:8080"})
    assert allowed == sorted({("sfly", 8080), *OFFICIAL})


def test_extra_entries_are_host_port_pairs_separated_by_spaces_or_commas() -> None:
    env = {
        "SFLY_PYPI_MIRROR": "file:///p",
        "SFLY_GITHUB_RELEASE_MIRROR": "file:///g",
        "SFLY_WORKBENCH_EGRESS": " db.internal:5432,sut:9000  10.0.0.7:22 [fd00::1]:80 ",
    }
    assert firewall.allowlist(env) == [
        ("10.0.0.7", 22),
        ("db.internal", 5432),
        ("fd00::1", 80),
        ("sut", 9000),
    ]


@pytest.mark.parametrize("bad", ["sut", "sut:", ":80", "sut:0", "sut:65536", "sut:http", "sut:٣"])
def test_a_malformed_extra_entry_stops_the_firewall_with_the_entry_named(bad: str) -> None:
    with pytest.raises(ValueError, match="主机:端口"):
        firewall.allowlist({"SFLY_WORKBENCH_EGRESS": bad})


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


def test_addresses_seen_within_an_hour_stay_allowed_and_older_ones_expire() -> None:
    answers = {"cdn.example.com": {"1.1.1.1"}}
    now = [0.0]

    def lookup(host: str, port: int) -> set[str]:
        if host not in answers:
            raise OSError("没有这个主机")
        return set(answers[host])

    wall = firewall.Firewall([("cdn.example.com", 443), ("gone", 80)], lookup, lambda: now[0])
    assert wall.allowed() == {("1.1.1.1", 443)}

    answers["cdn.example.com"] = {"2.2.2.2"}
    now[0] = 1800
    assert wall.allowed() == {("1.1.1.1", 443), ("2.2.2.2", 443)}

    now[0] = 3601 + 1800
    answers["cdn.example.com"] = {"3.3.3.3"}
    assert wall.allowed() == {("3.3.3.3", 443)}
