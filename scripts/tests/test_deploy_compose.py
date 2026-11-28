"""deploy/docker-compose.yml 的 assistant profile（#549）：
助手和工作台是可选的，不开时部署和没有它们时一样。

用 `docker compose config --format json`（compose 自己解析、展开变量）检查，
不起任何容器；没有 docker compose 时跳过。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest

DEPLOY = Path(__file__).resolve().parents[2] / "deploy"

# 控制面必填的两项（docker-compose.yml 里是 ${变量:?}）。
# 其余都不设：开助手的变量也一样，不设时必须能展开。
REQUIRED = {
    "DATABASE_URL": "postgres://sfly:secret@db.internal:5432/sfly",
    "SFLY_PUBLIC_URL": "http://sfly.internal:8080",
}
ASSISTANT = {
    "SFLY_ASSISTANT_SECRET": "0123456789abcdef0123456789abcdef0123456789abcdef",
    "SFLY_WORKBENCH_NAME": "workbench",
    "SFLY_WORKBENCH_TOKEN": "sfly_agt_" + "x" * 48,
    "MODEL_API_KEY": "model-key-value",
    "SFLY_ASSISTANT_MODEL": "gateway/some-model",
}

pytestmark = pytest.mark.skipif(
    shutil.which("docker") is None
    or subprocess.run(["docker", "compose", "version"], capture_output=True).returncode != 0,
    reason="需要 docker compose",
)


def render(
    tmp_path: Path, variables: dict[str, str], *profiles: str, override: str | None = None
) -> dict[str, Any]:
    """`override`：docker-compose.override.yml 的内容（README 里给部署者的示例）。"""
    # 空的 env 文件：不读部署者放在 deploy/ 里的 .env。
    empty = tmp_path / "empty.env"
    empty.write_text("")
    env = {key: os.environ[key] for key in ("PATH", "HOME", "DOCKER_HOST") if key in os.environ}
    env.update(variables)
    command = ["docker", "compose", "--env-file", str(empty)]
    for profile in profiles:
        command += ["--profile", profile]
    command += ["-f", str(DEPLOY / "docker-compose.yml")]
    if override is not None:
        extra = tmp_path / "docker-compose.override.yml"
        extra.write_text(override)
        command += ["-f", str(extra)]
    command += ["config", "--format", "json"]
    result = subprocess.run(command, env=env, capture_output=True, text=True, cwd=tmp_path)
    assert result.returncode == 0, result.stderr
    rendered: dict[str, Any] = json.loads(result.stdout)
    return rendered


def environment(service: dict[str, Any]) -> dict[str, str]:
    values: dict[str, str] = service.get("environment", {})
    return values


def test_without_the_profile_only_the_control_plane_exists(tmp_path: Path) -> None:
    # 助手的变量一个都没设：不开助手的部署不会因为它们报错（${变量:?} 会，所以那两个服务里没有它）。
    config = render(tmp_path, REQUIRED)

    assert list(config["services"]) == ["sfly"]
    # 助手和工作台的卷不出现：不带 profile 时 compose 的输出里只有控制面的数据卷。
    assert list(config["volumes"]) == ["sfly-data"]


def test_the_profile_adds_the_assistant_and_the_workbench_and_leaves_the_control_plane_alone(
    tmp_path: Path,
) -> None:
    plain = render(tmp_path, {**REQUIRED, **ASSISTANT})
    with_profile = render(tmp_path, {**REQUIRED, **ASSISTANT}, "assistant")

    assert sorted(with_profile["services"]) == [
        "sfly",
        "sfly-assistant",
        "sfly-workbench",
        "sfly-workbench-firewall",
    ]
    assert with_profile["services"]["sfly"] == plain["services"]["sfly"]


def test_neither_the_assistant_nor_the_workbench_publishes_a_port(tmp_path: Path) -> None:
    services = render(tmp_path, {**REQUIRED, **ASSISTANT}, "assistant")["services"]

    # 控制面映射 HTTP 和 Agent 网关两个端口；助手服务只让控制面连，
    # 工作台的能力端口没有认证：这两个都不映射。
    assert len(services["sfly"]["ports"]) == 2
    assert "ports" not in services["sfly-assistant"]
    assert "ports" not in services["sfly-workbench"]
    assert "ports" not in services["sfly-workbench-firewall"]


def test_the_workbench_credential_goes_to_the_workbench_only(tmp_path: Path) -> None:
    services = render(tmp_path, {**REQUIRED, **ASSISTANT}, "assistant")["services"]
    token = ASSISTANT["SFLY_WORKBENCH_TOKEN"]

    assert environment(services["sfly-workbench"])["SFLY_WORKBENCH_TOKEN"] == token
    for other in ("sfly", "sfly-assistant", "sfly-workbench-firewall"):
        assert token not in json.dumps(services[other]), other
    # 模型的密钥只给助手容器。
    assert environment(services["sfly-assistant"])["MODEL_API_KEY"] == "model-key-value"
    for other in ("sfly", "sfly-workbench", "sfly-workbench-firewall"):
        assert "model-key-value" not in json.dumps(services[other]), other


def test_the_shared_agent_token_never_reaches_the_workbench(tmp_path: Path) -> None:
    # 登记工作台之后控制面不再接受共享令牌（#549），工作台本来也不用它：
    # 共享令牌（SFLY_AGENT_TOKEN）能冒充任何一台 Agent，工作台上的模型读得到工作台的环境，
    # 所以它只给控制面，不给工作台和助手服务。
    shared = "shared-agent-token-value-0123456789"
    services = render(tmp_path, {**REQUIRED, **ASSISTANT, "SFLY_AGENT_TOKEN": shared}, "assistant")[
        "services"
    ]

    assert environment(services["sfly"])["SFLY_AGENT_TOKEN"] == shared
    for other in ("sfly-workbench", "sfly-assistant", "sfly-workbench-firewall"):
        assert shared not in json.dumps(services[other]), other
    # 工作台用的是它自己的 Agent 凭据。
    workbench = environment(services["sfly-workbench"])
    assert workbench["SFLY_WORKBENCH_TOKEN"] == ASSISTANT["SFLY_WORKBENCH_TOKEN"]
    assert workbench["SFLY_WORKBENCH_TOKEN"].startswith("sfly_agt_")


def test_the_assistant_secrets_do_not_reach_the_workbench(tmp_path: Path) -> None:
    # 工作台上的模型读得到工作台的环境：助手的共享密钥只给控制面和助手服务，模型的密钥只给助手服务，
    # 工作台只拿它自己要的四个变量（加一个别的变量，这里就红）。
    services = render(tmp_path, {**REQUIRED, **ASSISTANT}, "assistant")["services"]
    workbench = services["sfly-workbench"]

    assert set(environment(workbench)) == {
        "SFLY_WORKBENCH_URL",
        "SFLY_WORKBENCH_NAME",
        "SFLY_WORKBENCH_PUBLIC_ADDRESS",
        "SFLY_WORKBENCH_TOKEN",
    }
    for secret in (ASSISTANT["SFLY_ASSISTANT_SECRET"], ASSISTANT["MODEL_API_KEY"]):
        assert secret not in json.dumps(workbench)
        assert secret not in json.dumps(services["sfly-workbench-firewall"])
    # 控制面和助手服务读同一个共享密钥。
    for holder in ("sfly", "sfly-assistant"):
        assert ASSISTANT["SFLY_ASSISTANT_SECRET"] in json.dumps(services[holder]), holder


def test_the_workbench_is_named_by_its_own_variable_and_the_control_plane_reads_none(
    tmp_path: Path,
) -> None:
    services = render(tmp_path, {**REQUIRED, **ASSISTANT}, "assistant")["services"]

    # 哪台 Agent 是工作台由项目管理员登记（PUT /projects/:project/workbench，#549），
    # 不是控制面的环境变量：控制面的环境里没有 SFLY_WORKBENCH_AGENT，
    # 也没有任何 SFLY_WORKBENCH_ 开头的变量。
    control_plane = environment(services["sfly"])
    assert "SFLY_WORKBENCH_AGENT" not in control_plane
    assert not [name for name in control_plane if name.startswith("SFLY_WORKBENCH")]
    workbench = environment(services["sfly-workbench"])
    assert "SFLY_WORKBENCH_AGENT" not in workbench
    assert workbench["SFLY_WORKBENCH_NAME"] == "workbench"
    # 控制面和助手服务共用同一个密钥（同一个变量）。
    secret = ASSISTANT["SFLY_ASSISTANT_SECRET"]
    assert environment(services["sfly"])["SFLY_ASSISTANT_SECRET"] == secret
    assert environment(services["sfly-assistant"])["SFLY_ASSISTANT_SECRET"] == secret
    # 工作台连控制面用服务名，对外的地址是自己的服务名（助手服务按它连能力端口）。
    assert workbench["SFLY_WORKBENCH_URL"] == "http://sfly:8080"
    assert workbench["SFLY_WORKBENCH_PUBLIC_ADDRESS"] == "sfly-workbench"


def test_the_workbench_name_defaults_to_workbench_and_can_be_changed(tmp_path: Path) -> None:
    without = {key: value for key, value in ASSISTANT.items() if key != "SFLY_WORKBENCH_NAME"}
    services = render(tmp_path, {**REQUIRED, **without}, "assistant")["services"]
    assert environment(services["sfly-workbench"])["SFLY_WORKBENCH_NAME"] == "workbench"
    renamed = render(
        tmp_path, {**REQUIRED, **ASSISTANT, "SFLY_WORKBENCH_NAME": "bench-2"}, "assistant"
    )["services"]
    assert environment(renamed["sfly-workbench"])["SFLY_WORKBENCH_NAME"] == "bench-2"


def test_the_assistant_container_is_capped_at_2_gib_and_reads_the_model_file_read_only(
    tmp_path: Path,
) -> None:
    models = tmp_path / "models.json"
    models.write_text("{}")
    services = render(
        tmp_path, {**REQUIRED, **ASSISTANT, "SFLY_ASSISTANT_MODELS_FILE": str(models)}, "assistant"
    )["services"]
    assistant = services["sfly-assistant"]

    assert int(assistant["mem_limit"]) == 2 * 1024**3
    mounts = {volume["target"]: volume for volume in assistant["volumes"]}
    assert mounts["/config/models.json"]["source"] == str(models)
    assert mounts["/config/models.json"]["read_only"] is True
    # 宿主机上没有模型文件时报错，不建一个同名的目录。
    assert mounts["/config/models.json"]["bind"]["create_host_path"] is False
    assert mounts["/data"]["type"] == "volume"


def test_the_workbench_keeps_its_home_and_its_workspace_on_volumes(tmp_path: Path) -> None:
    services = render(tmp_path, {**REQUIRED, **ASSISTANT}, "assistant")["services"]
    workbench = services["sfly-workbench"]

    mounts = {volume["target"]: volume for volume in workbench["volumes"]}
    assert set(mounts) == {"/home/workbench", "/work"}
    assert {volume["type"] for volume in mounts.values()} == {"volume"}
    # 控制面健康之后再起：入口脚本要从它下载安装脚本。
    assert workbench["depends_on"]["sfly"]["condition"] == "service_healthy"
    # 没有 init 时 Agent 做 PID 1，收不了它留下的僵尸进程、也转不了信号。
    assert workbench["init"] is True
    assert services["sfly-assistant"]["init"] is True


# ---- README「助手和工作台」里给部署者的 docker-compose.override.yml 示例（照着执行一遍）----


def readme_override_examples() -> dict[str, str]:
    """README 那一节里的三段 yaml，按它们各自要做的事命名。"""
    readme = (DEPLOY.parent / "README.md").read_text(encoding="utf-8")
    section = readme[readme.index("### 助手和工作台") : readme.index("### 助手的模型")]
    blocks = re.findall(r"```yaml\n(.*?)```", section, flags=re.DOTALL)
    named: dict[str, str] = {}
    for block in blocks:
        if "aliases:" in block:
            named["alias"] = block
        elif "extra_hosts:" in block:
            named["extra_hosts"] = block
        elif ".netrc" in block:
            named["netrc"] = block
    assert set(named) == {"alias", "extra_hosts", "netrc"}, f"README 里的 yaml 示例变了：{blocks}"
    return named


def test_the_readme_alias_example_gives_the_control_plane_the_public_host_name(
    tmp_path: Path,
) -> None:
    # 公开地址的主机名在工作台容器里解析到控制面容器（浏览器看到的地址不用改成服务名）。
    example = readme_override_examples()["alias"]
    config = render(tmp_path, {**REQUIRED, **ASSISTANT}, "assistant", override=example)

    assert config["services"]["sfly"]["networks"]["default"]["aliases"] == ["sfly.example.com"]
    # 工作台共用出网名单那个服务的网络命名空间，它和控制面在同一个网络里，别名对它有效。
    assert "networks" in config["services"]["sfly-workbench-firewall"]


def test_the_readme_extra_hosts_example_points_the_public_host_name_at_the_docker_host(
    tmp_path: Path,
) -> None:
    example = readme_override_examples()["extra_hosts"]
    config = render(tmp_path, {**REQUIRED, **ASSISTANT}, "assistant", override=example)

    # 工作台共用出网名单那个服务的网络和 /etc/hosts：extra_hosts 加在它上面。
    hosts = config["services"]["sfly-workbench-firewall"]["extra_hosts"]
    # compose 的版本不同，输出是列表（`主机名=host-gateway`）或映射。
    pairs = hosts if isinstance(hosts, dict) else dict(h.split("=", 1) for h in hosts)
    assert pairs == {"sfly.example.com": "host-gateway"}


def test_the_readme_netrc_example_mounts_a_read_only_file_next_to_the_home_volume(
    tmp_path: Path,
) -> None:
    example = readme_override_examples()["netrc"]
    config = render(tmp_path, {**REQUIRED, **ASSISTANT}, "assistant", override=example)

    mounts = {v["target"]: v for v in config["services"]["sfly-workbench"]["volumes"]}
    assert set(mounts) == {"/home/workbench", "/work", "/home/workbench/.netrc"}
    netrc = mounts["/home/workbench/.netrc"]
    assert netrc["type"] == "bind" and netrc["read_only"] is True
    assert netrc["source"].endswith("workbench.netrc")
    # 家目录还是命名卷：.netrc 是叠在它上面的一个文件，卷里的东西不受影响。
    assert mounts["/home/workbench"]["type"] == "volume"


# ---- 出网名单（#498）----


def test_the_workbench_shares_the_firewall_network_namespace_and_has_no_extra_capability(
    tmp_path: Path,
) -> None:
    services = render(tmp_path, {**REQUIRED, **ASSISTANT}, "assistant")["services"]
    workbench = services["sfly-workbench"]
    firewall = services["sfly-workbench-firewall"]

    assert workbench["network_mode"] == "service:sfly-workbench-firewall"
    assert "networks" not in workbench
    gate = workbench["depends_on"]["sfly-workbench-firewall"]
    assert gate["condition"] == "service_healthy" and gate["restart"] is True
    assert "cap_add" not in workbench and "user" not in workbench
    # 只有写规则的那个服务有 NET_ADMIN，别的能力全去掉；能力端口的地址（网络别名）挂在它上面。
    assert firewall["user"] == "root"
    assert firewall["cap_drop"] == ["ALL"] and firewall["cap_add"] == ["NET_ADMIN"]
    assert firewall["entrypoint"] == ["/usr/local/bin/sfly-workbench-firewall"]
    assert firewall["networks"]["default"]["aliases"] == ["sfly-workbench"]
    assert firewall["image"] == workbench["image"]
    assert "test" in firewall["healthcheck"]


def test_the_firewall_reads_the_control_plane_mirrors_and_the_extra_entries(tmp_path: Path) -> None:
    variables = {
        **REQUIRED,
        **ASSISTANT,
        "SFLY_PYPI_MIRROR": "https://mirrors.example.com/pypi/simple",
        "SFLY_WORKBENCH_EGRESS": "db.internal:5432 sut.internal:9000",
    }
    firewall = render(tmp_path, variables, "assistant")["services"]["sfly-workbench-firewall"]

    assert environment(firewall) == {
        "SFLY_WORKBENCH_URL": "http://sfly:8080",
        "SFLY_PUBLIC_URL": REQUIRED["SFLY_PUBLIC_URL"],
        "SFLY_PUBLIC_GRPC_URL": "",
        "SFLY_PYPI_MIRROR": "https://mirrors.example.com/pypi/simple",
        "SFLY_GITHUB_RELEASE_MIRROR": "",
        "SFLY_WORKBENCH_EGRESS": "db.internal:5432 sut.internal:9000",
    }
