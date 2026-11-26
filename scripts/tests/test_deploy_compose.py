"""deploy/docker-compose.yml 的 assistant profile（#549）：
助手和工作台是可选的，不开时部署和没有它们时一样。

用 `docker compose config --format json`（compose 自己解析、展开变量）检查，
不起任何容器；没有 docker compose 时跳过。
"""

from __future__ import annotations

import json
import os
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
    "SFLY_WORKBENCH_AGENT": "workbench",
    "SFLY_WORKBENCH_TOKEN": "sfly_agt_" + "x" * 48,
    "MODEL_API_KEY": "model-key-value",
    "SFLY_ASSISTANT_MODEL": "gateway/some-model",
}

pytestmark = pytest.mark.skipif(
    shutil.which("docker") is None
    or subprocess.run(["docker", "compose", "version"], capture_output=True).returncode != 0,
    reason="需要 docker compose",
)


def render(tmp_path: Path, variables: dict[str, str], *profiles: str) -> dict[str, Any]:
    # 空的 env 文件：不读部署者放在 deploy/ 里的 .env。
    empty = tmp_path / "empty.env"
    empty.write_text("")
    env = {key: os.environ[key] for key in ("PATH", "HOME", "DOCKER_HOST") if key in os.environ}
    env.update(variables)
    command = ["docker", "compose", "--env-file", str(empty)]
    for profile in profiles:
        command += ["--profile", profile]
    command += ["-f", str(DEPLOY / "docker-compose.yml"), "config", "--format", "json"]
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

    assert sorted(with_profile["services"]) == ["sfly", "sfly-assistant", "sfly-workbench"]
    assert with_profile["services"]["sfly"] == plain["services"]["sfly"]


def test_neither_the_assistant_nor_the_workbench_publishes_a_port(tmp_path: Path) -> None:
    services = render(tmp_path, {**REQUIRED, **ASSISTANT}, "assistant")["services"]

    # 控制面映射 HTTP 和 Agent 网关两个端口；助手服务只让控制面连，
    # 工作台的能力端口没有认证：这两个都不映射。
    assert len(services["sfly"]["ports"]) == 2
    assert "ports" not in services["sfly-assistant"]
    assert "ports" not in services["sfly-workbench"]


def test_the_workbench_credential_goes_to_the_workbench_only(tmp_path: Path) -> None:
    services = render(tmp_path, {**REQUIRED, **ASSISTANT}, "assistant")["services"]
    token = ASSISTANT["SFLY_WORKBENCH_TOKEN"]

    assert environment(services["sfly-workbench"])["SFLY_WORKBENCH_TOKEN"] == token
    for other in ("sfly", "sfly-assistant"):
        assert token not in json.dumps(services[other]), other
    # 模型的密钥只给助手容器。
    assert environment(services["sfly-assistant"])["MODEL_API_KEY"] == "model-key-value"
    for other in ("sfly", "sfly-workbench"):
        assert "model-key-value" not in json.dumps(services[other]), other


def test_the_workbench_is_named_by_the_variable_the_control_plane_reads(tmp_path: Path) -> None:
    services = render(tmp_path, {**REQUIRED, **ASSISTANT}, "assistant")["services"]

    assert environment(services["sfly"])["SFLY_WORKBENCH_AGENT"] == "workbench"
    workbench = environment(services["sfly-workbench"])
    assert workbench["SFLY_WORKBENCH_AGENT"] == "workbench"
    # 控制面和助手服务共用同一个密钥（同一个变量）。
    secret = ASSISTANT["SFLY_ASSISTANT_SECRET"]
    assert environment(services["sfly"])["SFLY_ASSISTANT_SECRET"] == secret
    assert environment(services["sfly-assistant"])["SFLY_ASSISTANT_SECRET"] == secret
    # 工作台连控制面用服务名，对外的地址是自己的服务名（助手服务按它连能力端口）。
    assert workbench["SFLY_WORKBENCH_URL"] == "http://sfly:8080"
    assert workbench["SFLY_WORKBENCH_PUBLIC_ADDRESS"] == "sfly-workbench"


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
