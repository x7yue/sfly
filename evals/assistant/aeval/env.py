"""评测环境：一个「槽位」是一整套互相隔离的容器。

| 容器 | 作用 |
|---|---|
| `sfly-aeval-<槽位>-mirror` | 镜像站（PyPI、GitHub Release），网络别名 `mirror.internal` |
| `sfly-aeval-<槽位>-pg` | PostgreSQL，数据在 tmpfs 里，重置时整库重建 |
| `sfly-aeval-<槽位>-cp` | 控制面，网络别名 `sfly.internal`，HTTP 映射到宿主机 127.0.0.1 |
| `sfly-aeval-<槽位>-dev` | 开发环境容器（工作台的雏形）：`--dev` 装的 Agent、uv、sfly、pi |
| `sfly-aeval-<槽位>-sut` | 被测机：普通的 Agent，上面跑着被测服务 |
| `sfly-aeval-<槽位>-assistant` | `up --assistant`：平台的助手服务，控制面把会话交给它 |

两个槽位可以同时跑会话，互不影响。容器、网络、卷都以 `sfly-aeval-` 开头，`down` 全部删掉。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from aeval import docker as d

EVALS_DIR = Path(__file__).resolve().parent.parent
DATA_HOME = Path(os.environ.get("AEVAL_HOME", Path.home() / ".local/share/sfly/evals"))
DEFAULT_SERVER_IMAGE = "ghcr.io/x7yue/sfly-server:0.5.0"
DEFAULT_WORKBENCH_IMAGE = "sfly-aeval-workbench:pi-1.6.0"
# 助手镜像从源码构建（README「前提」）；控制面也要用源码构建的（会话模块在 0.5.0 之后）。
DEFAULT_ASSISTANT_IMAGE = "sfly-assistant:dev"
ASSISTANT_PORT = 8090
# 助手容器上记着它用的是模型配置里的哪个模型：之后的命令（reset、e2e）照着重建。
ASSISTANT_MODEL_LABEL = "sfly.aeval.assistant-model"
ASSISTANT_SECRET_ENV = "SFLY_ASSISTANT_SECRET"
REPO_DIR = EVALS_DIR.parent.parent
POSTGRES_IMAGE = "postgres:18"
SUT_AGENT = "sut-01"
# 初始管理员：给 Agent 签发凭据要登录（不带凭据是 401，#492）。登录名固定，
# 密码每次建库随机生成，只放在内存里，
# 经环境变量名（不在命令行参数里）交给控制面，经标准输入交给 curl。
# 登录名的规则（`packages/schema` 的 `LOGIN_NAME_PATTERN`）：小写字母、数字、下划线，
# 不能含连字符；不合规矩控制面起不来。
ADMIN_LOGIN = "aeval_admin"
ADMIN_PASSWORD_ENV = "SFLY_ADMIN_PASSWORD"
# 助手在评测里的身份（命令环境里的 `SFLY_NICKNAME`）：臂 A 的命令直接带它；平台臂经控制面登录，
# 会话和助手的命令记在登录的用户的**显示名**下（带凭据的请求取显示名，没配时是登录名
# `aeval_admin`），所以初始管理员的显示名设成它（`SFLY_ADMIN_DISPLAY_NAME`）：两臂的助手是同一个
# 身份，联调副本的名字（「demo 巡检-联调-eval」）、`run show latest` 找「自己触发的运行」才对得上。
# **只写这一份**，各处引用它，不另写 `"eval"`。
ASSISTANT_NICKNAME = "eval"
# 两台 Agent 的配置文件（install.sh 写的）：凭据换了要改这里的 SFLY_TOKEN。
AGENT_ENV_FILE = "/root/.sfly/agent.env"
# 开发环境容器里 Agent 的名称：沿用以前 `install.sh --dev` 默认的 dev-<用户名>-<主机名>
# （容器里是 root、主机名 dev）。`install.sh --dev` 不给 --name 时现在向控制面注册，
# 名字是 dev-<登录名>-<主机>、凭据记在登录的人名下（#492）；评测里不要换了名字就改了题目的前提，
# 所以自己起名字：`--dev --name` 照旧可用，凭据是下面给这个名字签发的 Agent 凭据。
DEV_AGENT = "dev-root-dev"
SERVICE_PORT = 9000
# 开发环境容器和被测机里放评测脚本（container/ 下的文件）的目录。
OPT = "/opt/aeval"
# 每台助手够得着的容器里放哪些脚本：只放这台要运行的，别的（假的模型端点、自检剧本……）不放。
# 这些文件的内容、文件名都不能有指向答案或判分的东西，
# 单测对着禁用词查（tests/test_assistant_files.py）。
# 臂 A 的助手在 dev 上，平台臂的命令也落在 dev 上；sut 的能力端口在评测网络里谁都连得上。
ASSISTANT_SCRIPTS: dict[str, tuple[str, ...]] = {
    "dev": ("session_driver.py", "pi_memory.py"),
    "sut": ("demo_svc.py",),
    "hardened": ("session_driver.py",),
}


SOURCE_LABEL = "sfly.aeval.source"


def source_hash(paths: list[Path], *extra: str) -> str | None:
    """构建一个镜像用到的源文件（目录取其中全部文件）的内容哈希；有文件不在（例如离线包里没有仓库的
    生成代码）时是 None：这时不知道镜像是不是旧的，用现有的。"""
    digest = hashlib.sha256()
    for item in extra:
        digest.update(item.encode())
    for path in paths:
        if not path.exists():
            return None
        files = sorted(f for f in path.rglob("*") if f.is_file()) if path.is_dir() else [path]
        for file in files:
            if "__pycache__" in file.parts:
                continue
            digest.update(file.name.encode())
            digest.update(file.read_bytes())
    return digest.hexdigest()[:16]


def image_source(image: str) -> str | None:
    result = d.docker(
        "image",
        "inspect",
        "--format",
        f'{{{{index .Config.Labels "{SOURCE_LABEL}"}}}}',
        image,
        check=False,
    )
    value = result.stdout.strip()
    # 没有这个标签时 docker 打印 <no value>。
    return value if result.returncode == 0 and value and value != "<no value>" else None


def needs_build(image: str, wanted: str | None) -> bool:
    """镜像不存在、或者它的源文件哈希和现在的不一样（改了 Dockerfile 或扩展）时要重新构建。"""
    if not d.exists("image", image):
        return True
    return wanted is not None and image_source(image) != wanted


def copy_scripts(container: str, role: str, evals_dir: Path = EVALS_DIR) -> None:
    d.sh(container, f"mkdir -p {OPT}")
    for name in ASSISTANT_SCRIPTS[role]:
        d.copy_in(str(evals_dir / "container" / name), container, f"{OPT}/{name}")


@dataclass
class Stack:
    """一个槽位的环境。"""

    slot: int = 1
    server_image: str = DEFAULT_SERVER_IMAGE
    workbench_image: str = DEFAULT_WORKBENCH_IMAGE
    # record：缺的文件从上游取并缓存；serve：只用缓存（离线）。
    mirror_mode: str = "record"
    # 断网：容器网络不通外网，也到不了宿主机（离线验证用）；模型只能用网络里的假端点。
    internal: bool = False
    # 在网络里起假的模型端点（fake-model.internal，只验证流程）。断网时总是起。
    fake_model: bool = False
    cache_dir: Path = field(default_factory=lambda: DATA_HOME / "mirror-cache")
    # 已有的镜像站（例如内网的 PyPI 和 GitHub Release 镜像）：给了就不用评测自带的镜像站。
    pypi_mirror: str = "http://mirror.internal:8000/pypi/simple"
    github_mirror: str = "http://mirror.internal:8000/github-release"
    evals_dir: Path = EVALS_DIR
    # 平台的助手（#543）：起助手容器，控制面配上它和工作台（dev 上的 Agent）。
    assistant: bool = False
    assistant_image: str = DEFAULT_ASSISTANT_IMAGE
    # 模型配置（aeval.models）里的模型名：fake 是假的模型端点，别的经宿主机的转发口。
    assistant_model: str = "fake"
    # 控制面和助手服务共用的密钥：up 时随机生成，之后从助手容器读回来；不打印、不写文件。
    assistant_secret: str | None = field(default=None, repr=False)
    # 初始管理员的密码：控制面每次建库（up、reset）时随机生成，放在内存里，
    # 也写进 `admin_file`（0600，给人登录控制台用）。
    admin_password: str | None = field(default=None, repr=False)

    @property
    def admin_file(self) -> Path:
        """这个槽位的初始管理员的登录名和密码（每次建库换一个）：只有属主能读的文件，
        `up` 打印它的路径，不打印密码。"""
        return DATA_HOME / f"admin-slot{self.slot}.txt"

    def _write_admin_file(self) -> None:
        """把初始管理员的登录名和密码写进 `admin_file`（0600）。控制面起来之后人要在浏览器里登录才能
        建会话（#547），密码只在这个进程的内存里的话，人拿不到；写进文件、打印路径，密码本身不进终端、
        不进命令行参数。"""
        assert self.admin_password
        path = self.admin_file
        path.parent.mkdir(parents=True, exist_ok=True)
        # 先以 0600 创建（已经存在的文件 open 不改权限，所以之后再 chmod 一次）：
        # 不让密码在任何时刻对别人可读。
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as file:
            file.write(
                f"# 槽位 {self.slot} 控制面的初始管理员（每次 up、reset 换密码；down 删掉）\n"
                f"login_name={ADMIN_LOGIN}\n"
                f"password={self.admin_password}\n"
            )
        os.chmod(path, 0o600)

    def name(self, role: str) -> str:
        return f"sfly-aeval-{self.slot}-{role}"

    @property
    def network(self) -> str:
        return f"sfly-aeval-{self.slot}"

    @property
    def http_port(self) -> int:
        return 18100 + self.slot

    @property
    def dev(self) -> str:
        return self.name("dev")

    @property
    def sut(self) -> str:
        return self.name("sut")

    @property
    def cp_url(self) -> str:
        return f"http://127.0.0.1:{self.http_port}"

    @property
    def assistant_container(self) -> str:
        return self.name("assistant")

    @property
    def assistant_url(self) -> str:
        return f"http://assistant.internal:{ASSISTANT_PORT}"

    # ---- 起停 ----

    def ensure_images(self, log: Any = print) -> None:
        """工作台镜像不存在时按 workbench/Dockerfile 构建；控制面和 PostgreSQL 的镜像要事先准备。"""
        for image in (self.server_image, POSTGRES_IMAGE):
            if not d.exists("image", image):
                raise d.DockerError(
                    f"没有镜像 {image}：先 docker load 或 docker pull，见 README.md「前提」"
                )
        wanted = self.workbench_source()
        if not needs_build(self.workbench_image, wanted):
            return
        log(f"构建工作台镜像 {self.workbench_image}（几分钟）")
        args = ["build", "-t", self.workbench_image, "--label", f"{SOURCE_LABEL}={wanted}"]
        for key, env in (
            ("DEBIAN_MIRROR", "AEVAL_DEBIAN_MIRROR"),
            ("NPM_REGISTRY", "AEVAL_NPM_REGISTRY"),
        ):
            if os.environ.get(env):
                args += ["--build-arg", f"{key}={os.environ[env]}"]
        tag = self.workbench_image.rsplit(":pi-", 1)
        if len(tag) == 2:
            args += ["--build-arg", f"PI_VERSION={tag[1]}"]
        d.docker(*args, str(self.evals_dir / "workbench"), timeout=3600)

    def workbench_source(self) -> str | None:
        return source_hash([self.evals_dir / "workbench"], self.workbench_image)

    def network_internal(self) -> bool | None:
        """网络现在是不是 internal（不通外网和宿主机）；网络不存在时是 None。"""
        result = d.docker(
            "network", "inspect", "--format", "{{.Internal}}", self.network, check=False
        )
        if result.returncode != 0:
            return None
        return result.stdout.strip() == "true"

    def ensure_network(self, log: Any = print) -> None:
        """网络已经存在、但是不是 internal 和要的不一样时（例如先 up、再 up --isolated），
        删掉这个槽位的全部容器和网络重建：不然 --isolated 会在一个通外网的网络上「就绪」。"""
        current = self.network_internal()
        if current is not None and current != self.internal:
            log(
                f"网络 {self.network} 的 internal 是 {current}，"
                f"要的是 {self.internal}：重建这个槽位"
            )
            self.down()
            current = None
        if current is None:
            args = ["network", "create"]
            if self.internal:
                args.append("--internal")
            d.docker(*args, self.network)

    def verify_isolated(self) -> None:
        """--isolated 时实际验证一次出不去：开发环境容器连不上外网，也连不上宿主机。

        连得上就失败。"""
        for url in ("https://mirrors.ustc.edu.cn/", "http://host.docker.internal:18900/"):
            probe = d.sh(self.dev, f"curl -sS -m 5 -o /dev/null {url}", check=False)
            if probe.returncode == 0:
                raise d.DockerError(f"--isolated 的网络里还连得上 {url}，不是断网的环境")

    def up(self, log: Any = print) -> None:
        self.ensure_images(log)
        if self.assistant:
            self.check_assistant_model()
            if self.assistant_model == "fake":
                self.fake_model = True
            self.assistant_secret = self.assistant_secret or secrets.token_hex(24)
        self.ensure_network(log)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        log(f"镜像站（{self.mirror_mode}）")
        self._run(
            "mirror",
            self.workbench_image,
            ["python3", "/aeval/container/mirror.py", self.mirror_mode],
            aliases=["mirror.internal"],
            volumes=[f"{self.cache_dir}:/cache", f"{self.evals_dir}:/aeval:ro"],
        )
        if self.fake_model or self.internal:
            log("假的模型端点")
            self._run(
                "fake",
                self.workbench_image,
                ["python3", "/aeval/container/fake_model.py"],
                aliases=["fake-model.internal"],
                volumes=[f"{self.evals_dir}:/aeval:ro"],
            )
        log("PostgreSQL")
        self._start_postgres()
        if self.assistant:
            log(f"助手服务 {self.assistant_image}（模型 {self.assistant_model}）")
            self._start_assistant()
        else:
            # 以前 up --assistant 留下的助手容器：之后的命令会照着它接着用，这次没要助手就删掉。
            d.docker("rm", "-f", self.assistant_container, check=False)
        log(f"控制面 {self.server_image}")
        self._start_control_plane()
        for role, memory in (("dev", "4g"), ("sut", "1g")):
            self._run(
                role,
                self.workbench_image,
                ["sleep", "infinity"],
                hostname=role,
                aliases=[role],
                extra=["--memory", memory, "--add-host", "host.docker.internal:host-gateway"],
            )
        # 评测目录不挂进这两台容器：里面有参考答案和看不到的断言，助手的命令够得着这两台。
        # 只复制这台要运行的脚本（ASSISTANT_SCRIPTS）。
        copy_scripts(self.dev, "dev", self.evals_dir)
        copy_scripts(self.sut, "sut", self.evals_dir)
        log("安装 Agent（按用户文档的 install.sh）")
        try:
            self._install_agents()
        except d.DockerError:
            # 下载 uv、Python、包失败时，上游回了什么只在镜像站的日志里（#847）。
            mirror_log = d.docker("logs", "--tail", "30", self.name("mirror"), check=False)
            log(f"镜像站最后的日志：\n{mirror_log.stderr}{mirror_log.stdout}")
            raise
        self.start_agents()
        self.wait_agents()
        # 共享 venv 的基线：每次重置恢复成它，`sfly dev` 和装过的节点包都不会留到下一次会话。
        self.stop_agents()
        for container in (self.dev, self.sut):
            d.sh(
                container,
                "rm -rf /root/.sfly/venv.base && cp -a /root/.sfly/venv /root/.sfly/venv.base",
            )
        self.start_service()
        if self.internal:
            self.verify_isolated()
            log("已确认断网：开发环境容器连不上外网和宿主机")
        if self.assistant:
            # 上面取完基线就停了 Agent（别的命令都先 reset 再用）；助手要工作台在线，这里重新起好，
            # up 完就能用。
            self.start_agents()
            self.wait_agents(timeout=180)
            self.register_workbench()
            self.wait_assistant_ready()
            log("助手就绪：工作台是 dev 上的 Agent（已登记）")
        log(f"初始管理员（登录控制台、建会话要先登录）：登录名和密码在 {self.admin_file}")
        log(f"环境就绪：控制面 {self.cp_url}")

    def down(self) -> None:
        for role in (
            "rpcprobe",
            "hardened",
            "pi",  # 以前臂 B 的 pi 容器（#552 删了）：留着名字，旧环境 down 时一起删
            "assistant",
            "dev",
            "sut",
            "cp",
            "pg",
            "mirror",
            "fake",
        ):
            d.docker("rm", "-f", self.name(role), check=False)
        d.docker("volume", "rm", self.name("cpdata"), check=False)
        d.docker("network", "rm", self.network, check=False)
        self.admin_file.unlink(missing_ok=True)

    def _run(
        self,
        role: str,
        image: str,
        argv: list[str],
        *,
        aliases: list[str] | None = None,
        hostname: str | None = None,
        volumes: list[str] | None = None,
        env: dict[str, str] | None = None,
        secret_env: dict[str, str] | None = None,
        ports: list[str] | None = None,
        extra: list[str] | None = None,
    ) -> None:
        """`secret_env`：secret 环境变量，参数里只写名字（`-e 名字`），
        值经 docker 命令行进程的环境带进去。"""
        name = self.name(role)
        d.docker("rm", "-f", name, check=False)
        args = ["run", "-d", "--name", name, "--network", self.network, "--init"]
        args += ["--label", "sfly.aeval=1"]
        for alias in aliases or []:
            args += ["--network-alias", alias]
        if hostname:
            args += ["--hostname", hostname]
        for volume in volumes or []:
            args += ["-v", volume]
        for key, value in (env or {}).items():
            args += ["-e", f"{key}={value}"]
        for key in secret_env or {}:
            args += ["-e", key]
        for port in ports or []:
            args += ["-p", port]
        args += extra or []
        d.docker(*args, image, *argv, env=secret_env)

    def _start_postgres(self) -> None:
        self._run(
            "pg",
            POSTGRES_IMAGE,
            [],
            env={"POSTGRES_USER": "sfly", "POSTGRES_PASSWORD": "sfly", "POSTGRES_DB": "sfly"},
            extra=["--tmpfs", "/var/lib/postgresql"],
        )
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            ready = d.docker(
                "exec", self.name("pg"), "pg_isready", "-U", "sfly", "-d", "sfly", check=False
            )
            if ready.returncode == 0:
                return
            time.sleep(1)
        raise d.DockerError("PostgreSQL 60 秒内没有就绪")

    def _start_control_plane(self) -> None:
        d.docker("volume", "rm", self.name("cpdata"), check=False)
        env = {
            "DATABASE_URL": f"postgres://sfly:sfly@{self.name('pg')}:5432/sfly",
            "SFLY_PUBLIC_URL": "http://sfly.internal:8080",
            "SFLY_PYPI_MIRROR": self.pypi_mirror,
            "SFLY_GITHUB_RELEASE_MIRROR": self.github_mirror,
        }
        # 初始管理员（库里还没有任何用户时由环境变量建出来）：给 Agent 签发凭据要登录；
        # 密码每次建库都换一个新的，参数里只写变量名。
        self.admin_password = secrets.token_hex(16)
        self._write_admin_file()
        env["SFLY_ADMIN_LOGIN"] = ADMIN_LOGIN
        env["SFLY_ADMIN_DISPLAY_NAME"] = ASSISTANT_NICKNAME
        secret_env: dict[str, str] = {ADMIN_PASSWORD_ENV: self.admin_password}
        if self.assistant:
            # 控制面把会话交给助手服务；工作台是 dev 上的 Agent，由 register_workbench 登记
            # （#549，存在库里，不是环境变量）。
            env["SFLY_ASSISTANT_URL"] = self.assistant_url
            secret_env[ASSISTANT_SECRET_ENV] = self._secret()
        self._run(
            "cp",
            self.server_image,
            [],
            aliases=["sfly.internal"],
            volumes=[f"{self.name('cpdata')}:/data"],
            env=env,
            secret_env=secret_env,
            # 断网的网络发布不了端口；所有操作本来就经 docker exec，不依赖它。
            ports=[] if self.internal else [f"127.0.0.1:{self.http_port}:8080"],
        )
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            status = d.docker(
                "inspect", "--format", "{{.State.Health.Status}}", self.name("cp"), check=False
            ).stdout.strip()
            if status == "healthy":
                return
            if not d.container_running(self.name("cp")):
                logs = d.docker("logs", "--tail", "30", self.name("cp"), check=False)
                raise d.DockerError("控制面容器退出了：\n" + logs.stdout + logs.stderr)
            time.sleep(1)
        raise d.DockerError("控制面 120 秒内没有变成 healthy")

    # ---- 助手（#543） ----

    def check_assistant_model(self) -> None:
        """助手用的模型在模型配置里；断网的环境只能用假的模型端点。"""
        from aeval.models import load_models

        if self.internal and self.assistant_model != "fake":
            raise d.DockerError(
                "断网的环境（--isolated）里助手只能用假的模型端点（--assistant-model fake）"
            )
        if self.assistant_model not in load_models():
            raise d.DockerError(f"模型配置里没有 {self.assistant_model}（见 README.md「模型」）")

    def assistant_models_file(self) -> Path:
        """挂给助手容器的模型文件（pi 的格式）：一个提供方 aeval，指向这个模型的端点，
        `apiKey` 是占位值
        （转发口转发时才加上凭据，见 aeval.models），文件里没有密钥。"""
        from aeval.models import load_models

        model = load_models()[self.assistant_model]
        path = DATA_HOME / "assistant" / f"slot-{self.slot}" / "models.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(model.pi_models_json(), ensure_ascii=False, indent=2))
        return path

    def assistant_model_ref(self) -> str:
        """`SFLY_ASSISTANT_MODEL`：照 pi 的 `--model` 写，`aeval/<模型 id>`，有思考强度时带上。"""
        from aeval.models import PROVIDER, load_models

        model = load_models()[self.assistant_model]
        ref = f"{PROVIDER}/{model.model_id}"
        return f"{ref}:{model.thinking}" if model.thinking else ref

    def _secret(self) -> str:
        if not self.assistant_secret:
            raise d.DockerError("没有控制面和助手服务共用的密钥：先 ./aeval.sh up --assistant")
        return self.assistant_secret

    def adopt_assistant(self) -> bool:
        """这个槽位已经起着助手容器时，照它接着用（镜像、模型、密钥）：reset、e2e 重建控制面和助手时
        沿用 up 时的设置。密钥从容器的环境读回来，只放在内存里。"""
        found = d.docker(
            "inspect",
            "--format",
            "{{json .Config.Env}}\t{{index .Config.Labels "
            f'"{ASSISTANT_MODEL_LABEL}"'
            "}}\t{{.Config.Image}}",
            self.assistant_container,
            check=False,
        )
        parts = found.stdout.strip().split("\t")
        if found.returncode != 0 or len(parts) != 3:
            return False
        env_json, model, image = parts
        try:
            listed = json.loads(env_json)
        except ValueError:
            return False
        values = dict(str(item).split("=", 1) for item in listed or [] if "=" in str(item))
        secret = values.get(ASSISTANT_SECRET_ENV)
        if not secret:
            return False
        self.assistant = True
        self.assistant_secret = secret
        self.assistant_image = image
        if model and model != "<no value>":
            self.assistant_model = model
        return True

    def _start_assistant(self) -> None:
        """助手容器：和别的容器同一个网络（连得到控制面、dev 上 Agent 的能力端口、假的模型端点），
        宿主机的模型转发口经 host.docker.internal。没有密钥以外的凭据：
        模型的凭据在宿主机的转发口里。"""
        if not d.exists("image", self.assistant_image):
            raise d.DockerError(
                f"没有助手镜像 {self.assistant_image}：先从源码构建，见 README.md「前提」"
            )
        models = self.assistant_models_file()
        self._run(
            "assistant",
            self.assistant_image,
            [],
            aliases=["assistant.internal"],
            volumes=[f"{models}:/config/models.json:ro"],
            env={"SFLY_ASSISTANT_MODEL": self.assistant_model_ref()},
            secret_env={ASSISTANT_SECRET_ENV: self._secret()},
            extra=[
                "--memory",
                "2g",
                "--label",
                f"{ASSISTANT_MODEL_LABEL}={self.assistant_model}",
                "--add-host",
                "host.docker.internal:host-gateway",
            ],
        )
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            logs = d.docker("logs", self.assistant_container, check=False)
            if "助手服务在 :" in logs.stdout + logs.stderr:
                return
            if not d.container_running(self.assistant_container):
                raise d.DockerError("助手容器退出了：\n" + (logs.stdout + logs.stderr)[-2000:])
            time.sleep(1)
        raise d.DockerError("助手服务 60 秒内没有起来")

    def readiness(self) -> dict[str, Any] | None:
        """控制面说助手此刻能不能用（`GET /projects/default/sessions` 的 readiness）；
        读不到时是 None。控制面没有会话的接口（404，镜像太旧）时直接报错，不用等。"""
        out = d.sh(
            self.dev,
            "curl -sS -m 10 -w '\\n%{http_code}' http://sfly.internal:8080/projects/default/sessions",
            check=False,
        )
        body, _, status = out.stdout.rpartition("\n")
        if status.strip() == "404":
            raise d.DockerError(
                "控制面没有会话的接口：--assistant 要用源码构建的控制面镜像"
                "（--server-image，见 README.md「前提」）"
            )
        try:
            value = json.loads(body).get("readiness")
        except (ValueError, AttributeError):
            return None
        return value if isinstance(value, dict) else None

    def wait_assistant_ready(self, timeout: float = 60) -> None:
        """等控制面说助手能用（助手服务连得上、工作台在线、能力端口有地址）。"""
        deadline = time.monotonic() + timeout
        ready: dict[str, Any] | None = None
        while time.monotonic() < deadline:
            ready = self.readiness()
            if ready and ready.get("ready"):
                return
            time.sleep(2)
        if ready is None:
            raise d.DockerError(f"{timeout:.0f} 秒内读不到控制面的就绪状态")
        problems = "；".join(str(p.get("message")) for p in ready.get("problems") or [])
        raise d.DockerError(f"助手在 {timeout:.0f} 秒内没有就绪：{problems}")

    def _admin_cookie(self, container: str) -> str:
        """管理员登录，返回 `sfly_login=…`（Cookie 的内容）。
        密码经标准输入给 curl，不在命令行参数里。"""
        if not self.admin_password:
            raise d.DockerError(
                "不知道初始管理员的密码：控制面不是这一次进程起的（先 ./aeval.sh up）"
            )
        out = d.sh(
            container,
            "curl -fsS -D - -o /dev/null -X POST -H 'content-type: application/json' "
            "--data-binary @- http://sfly.internal:8080/auth/login",
            input_text=json.dumps({"login_name": ADMIN_LOGIN, "password": self.admin_password}),
        )
        match = re.search(r"(?im)^set-cookie:\s*(sfly_login=[^;\s]+)", out.stdout)
        if not match:
            raise d.DockerError("管理员登录没有拿到登录 Cookie")
        return match.group(1)

    def _agent_credential(self, container: str, name: str) -> str:
        """向控制面为这台 Agent 签发 Agent 凭据（#492）：没有凭据的 Agent 只接受已登记过的名字，
        全新的环境里谁都没登记过；签发要登录，用初始管理员。凭据只交给这台 Agent 的安装脚本
        （环境变量 `SFLY_TOKEN`，写进它的 agent.env）。
        Cookie 经标准输入给 curl（`-H @-`），不在命令行参数里。"""
        cookie = self._admin_cookie(container)
        out = d.sh(
            container,
            "curl -fsS -X POST -H 'content-type: application/json' -H @- -d '{}' "
            f"http://sfly.internal:8080/projects/default/agents/{name}/credentials",
            input_text=f"cookie: {cookie}\nsec-fetch-site: same-origin\n",
        )
        return str(json.loads(out.stdout)["token"])

    def register_workbench(self) -> None:
        """登记 dev 上的 Agent 为默认项目的工作台（`PUT /projects/default/workbench`，#549）：
        和部署文档里的 `sfly api PUT …` 是同一个接口，这里用初始管理员的登录。登记要这台 Agent
        已经用自己的 Agent 凭据连上来过（两台 Agent 的凭据都是上面签发的），所以放在 `wait_agents`
        之后；登记之后控制面只接受 Agent 凭据，共享令牌和不带凭据的连接都被拒绝
        （评测环境里本来就没有）。Cookie 经标准输入给 curl，不在命令行参数里。"""
        cookie = self._admin_cookie(self.dev)
        d.sh(
            self.dev,
            "curl -fsS -X PUT -H 'content-type: application/json' -H @- "
            f"-d '{json.dumps({'agent': DEV_AGENT})}' "
            "http://sfly.internal:8080/projects/default/workbench",
            input_text=f"cookie: {cookie}\nsec-fetch-site: same-origin\n",
        )

    def _renew_agent_credentials(self) -> None:
        """控制面的库重建之后（reset），登记和凭据都没了，两台 Agent 的 agent.env 里还是旧凭据：
        重新签发、换掉 agent.env 里的 SFLY_TOKEN（经标准输入，不在命令行参数里）。"""
        for container, name in ((self.dev, DEV_AGENT), (self.sut, SUT_AGENT)):
            token = self._agent_credential(container, name)
            d.sh(
                container,
                "IFS= read -r token; "
                f'sed -i "s|^SFLY_TOKEN=.*|SFLY_TOKEN=$token|" {AGENT_ENV_FILE} '
                f"&& grep -q '^SFLY_TOKEN=' {AGENT_ENV_FILE}",
                input_text=token + "\n",
            )

    def _install_agents(self) -> None:
        url = "http://sfly.internal:8080/install.sh"
        dev_token = self._agent_credential(self.dev, DEV_AGENT)
        sut_token = self._agent_credential(self.sut, SUT_AGENT)
        d.sh(
            self.dev,
            f"curl -fsSL {url} | sh -s -- --dev --name {DEV_AGENT} --no-service",
            secret_env={"SFLY_TOKEN": dev_token},
            timeout=600,
        )
        d.sh(
            self.sut,
            f"curl -fsSL {url} | sh -s -- --name {SUT_AGENT} --no-service",
            secret_env={"SFLY_TOKEN": sut_token},
            timeout=600,
        )
        # 安装脚本提示 ~/.local/bin 不在 PATH 上时，按用户文档把它加进 shell 配置。
        d.sh(
            self.dev,
            "line='export PATH=\"$HOME/.local/bin:$PATH\"'; "
            "for f in /root/.profile /root/.bashrc; do "
            'grep -qxF "$line" $f 2>/dev/null || echo "$line" >> $f; done',
        )

    # ---- Agent ----

    def start_agents(self) -> None:
        for container in (self.dev, self.sut):
            d.detach(
                container,
                ["sh", "-c", "exec /root/.sfly/bin/sfly-agent >> /var/log/sfly-agent.log 2>&1"],
            )

    def stop_agents(self) -> None:
        for container in (self.dev, self.sut):
            d.sh(
                container,
                "pkill -TERM -f '[/]root/.sfly/bin/sfly-agent' || true; "
                "for i in $(seq 50); do "
                "pgrep -f '[/]root/.sfly/bin/sfly-agent' >/dev/null || exit 0; sleep 0.2; done; "
                "pkill -KILL -f '[/]root/.sfly/bin/sfly-agent' || true",
            )

    def agents(self) -> list[dict[str, Any]]:
        out = self.sfly("agent", "list", "--json", check=False)
        if out.returncode != 0:
            return []
        data = json.loads(out.stdout or "[]")
        return data if isinstance(data, list) else []

    def wait_agents(self, timeout: float = 600) -> None:
        """等两台 Agent 都在线、准备好环境。第一次要下载 uv 和 Python，要一两分钟。"""
        deadline = time.monotonic() + timeout
        ready: set[str] = set()
        while time.monotonic() < deadline:
            ready = {
                str(a.get("name"))
                for a in self.agents()
                if a.get("status") == "online" and not a.get("preparing_since")
            }
            if {DEV_AGENT, SUT_AGENT} <= ready:
                return
            for container in (self.dev, self.sut):
                if not d.sh(
                    container, "pgrep -f '[/]root/.sfly/bin/sfly-agent'", check=False
                ).stdout:
                    tail = d.sh(container, "tail -n 40 /var/log/sfly-agent.log", check=False).stdout
                    raise d.DockerError(f"{container} 上的 Agent 退出了：\n{tail}")
            time.sleep(2)
        raise d.DockerError(f"Agent 没有在 {timeout:.0f} 秒内准备好（已就绪：{sorted(ready)}）")

    # ---- 被测服务 ----

    def start_service(self) -> None:
        """在被测机上起被测服务（通用的 HTTP 服务，写自己的日志）。重置时也会重启它。"""
        d.sh(
            self.sut,
            "pkill -f '[d]emo_svc.py' || true; mkdir -p /var/log/demo-svc",
        )
        d.detach(
            self.sut,
            [
                "sh",
                "-c",
                f"exec python3 {OPT}/demo_svc.py --port {SERVICE_PORT} "
                ">> /var/log/demo-svc/stdout.log 2>&1",
            ],
        )
        for _ in range(50):
            ok = d.sh(self.sut, f"curl -fsS http://127.0.0.1:{SERVICE_PORT}/health", check=False)
            if ok.returncode == 0:
                return
            time.sleep(0.2)
        raise d.DockerError("被测服务没有起来")

    # ---- 重置 ----

    def reset(self) -> None:
        """回到刚 `up` 完的状态：控制面整库重建，Agent 的工作目录、开发包和共享 venv 恢复成基线。

        dev、sut 重启一次：上一次会话里助手起的后台进程不会留到下一次；/tmp 清空。
        家目录里 Agent、uv、sfly 之外的东西不清（uv 的缓存要留着），这一点不完全隔离。
        """
        self.stop_agents()
        containers = [c for c in (self.dev, self.sut) if d.container_running(c)]
        d.docker("restart", "-t", "2", *containers)
        d.docker("rm", "-f", self.name("cp"), check=False)
        pg = self.name("pg")
        d.docker("exec", pg, "dropdb", "-U", "sfly", "--force", "--if-exists", "sfly")
        d.docker("exec", pg, "createdb", "-U", "sfly", "sfly")
        if self.assistant:
            # 助手服务也重建：上一次的会话、pi 进程和会话目录不留到下一次（库已经重建了）。
            self._start_assistant()
        self._start_control_plane()
        # 库重建了：登记和 Agent 凭据都没了，两台 Agent 的配置里还是旧凭据，
        # 重启后会被拒绝。重新签发并换上。
        self._renew_agent_credentials()
        for container in (self.dev, self.sut):
            d.sh(
                container,
                "rm -rf /root/.sfly/work /root/.sfly/procs /root/.sfly/venv /work /root/.pi "
                f"/root/aeval-session {OPT} && find /tmp -mindepth 1 -delete "
                "&& cp -a /root/.sfly/venv.base /root/.sfly/venv && : > /var/log/sfly-agent.log",
            )
        # 每次重置都重新放一份脚本：环境起好以后改过的会话驱动等也能用上，以前多放的也清掉了。
        copy_scripts(self.dev, "dev", self.evals_dir)
        copy_scripts(self.sut, "sut", self.evals_dir)
        self.start_agents()
        self.wait_agents(timeout=180)
        self.start_service()
        if self.assistant:
            # 库重建了，工作台的登记也没了：Agent 重新连上来之后再登记。
            self.register_workbench()
            self.wait_assistant_ready()

    # ---- 在开发环境容器里执行 ----

    def sfly(self, *args: str, check: bool = True, workdir: str | None = None) -> Any:
        """以「评分」的身份在开发环境容器里执行 sfly 命令行。"""
        quoted = " ".join(_quote(a) for a in args)
        return d.sh(
            self.dev,
            f"sfly {quoted}",
            env={"SFLY_NICKNAME": "grader"},
            workdir=workdir,
            check=check,
            timeout=900,
        )


def _quote(value: str) -> str:
    return "'" + value.replace("'", "'\\''") + "'"
