//! 切入点 B（Agent 一侧）：开发模式。`sfly dev <项目>` 通过 Agent 的本地 socket 让 Agent 把源码目录
//! 以可编辑方式装进共享 venv，注册为 `包名@dev` 并上报控制面；修改源码后下一次运行生效；
//! 没有加载开发版本的 Agent 收到 `@dev` 任务时以 env_error 失败；已发布版本照常执行。

mod support;

use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use sfly_agent::proto::{AssignTask, DevPackage, ErrorKind, InstallState, TaskResult, TaskStatus};
use support::packages::{HttpFixture, fresh_venv, package_task, publish, venv_of};
use support::{AgentOptions, AgentProcess, FakeControlPlane, repo_root, spawn_agent};

fn outputs(result: &TaskResult) -> Value {
    serde_json::from_str(&result.outputs_json).expect("outputs_json is JSON")
}

fn agent(
    cp: &FakeControlPlane,
    name: &str,
    venv: &tempfile::TempDir,
    fixture: &HttpFixture,
) -> AgentProcess {
    let cache = venv.path().join("uv-cache").to_string_lossy().into_owned();
    let venv = venv_of(venv);
    let mut options = AgentOptions::new(&cp.url, name);
    options.venv = &venv;
    options.args = vec!["--index-url".into(), fixture.index_url()];
    options.env = vec![("UV_CACHE_DIR", &cache)];
    spawn_agent(options)
}

/// 本地开发中的节点包项目：`src/<模块>/__init__.py` 里有一个 `about` 节点，返回 `{"source": <标记>}`。
struct DevProject {
    dir: tempfile::TempDir,
    module: String,
}

impl DevProject {
    fn new(name: &str, marker: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let module = name.replace('-', "_");
        std::fs::create_dir_all(dir.path().join("src").join(&module)).unwrap();
        std::fs::write(
            dir.path().join("pyproject.toml"),
            format!("[project]\nname = \"{name}\"\nversion = \"0.9.0\"\ndependencies = []\n"),
        )
        .unwrap();
        let project = Self { dir, module };
        project.write(marker);
        project
    }

    fn root(&self) -> &Path {
        self.dir.path()
    }

    /// 改写节点源码：`about` 返回新的标记。
    fn write(&self, marker: &str) {
        std::fs::write(
            self.dir
                .path()
                .join("src")
                .join(&self.module)
                .join("__init__.py"),
            format!(
                "from sfly import node\n\n\n@node\ndef about() -> dict:\n    return {{\"source\": {marker:?}}}\n"
            ),
        )
        .unwrap();
    }
}

fn socket_of(agent: &AgentProcess) -> PathBuf {
    agent.work_dir.path().join("agent.sock")
}

/// 运行真实的 `sfly dev <项目> --socket <Agent 的本地 socket>`，返回 (退出成功, 标准输出 + 标准错误)。
fn sfly_dev(project: &Path, socket: &Path) -> (bool, String) {
    let output = std::process::Command::new("uv")
        .args(["run", "--locked", "--quiet", "sfly", "dev"])
        .arg(project)
        .arg("--socket")
        .arg(socket)
        .current_dir(repo_root())
        .output()
        .expect("run sfly dev");
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    (output.status.success(), text)
}

fn dev_task(task_id: &str, package: &str, node: &str) -> AssignTask {
    AssignTask {
        task_id: task_id.into(),
        attempt: 1,
        package: package.into(),
        package_version: "dev".into(),
        node: node.into(),
        inputs_json: "{}".into(),
        timeout_seconds: 3600,
        run_id: "run-1".into(),
        node_id: format!("node-{node}"),
        ..Default::default()
    }
}

fn dev_names(list: &[DevPackage]) -> Vec<(String, String)> {
    list.iter()
        .map(|p| (p.name.clone(), p.source.clone()))
        .collect()
}

#[tokio::test]
async fn sfly_dev_installs_the_source_editable_registers_it_as_dev_and_reports_to_the_control_plane()
 {
    let fixture = HttpFixture::start().await;
    let venv = fresh_venv(true);
    let cp = FakeControlPlane::start().await;
    let agent = agent(&cp, "agent-dev", &venv, &fixture);
    assert_eq!(cp.hello(0).await.dev_packages, vec![]);
    let project = DevProject::new("sfly-devpkg", "v1");
    let source = std::fs::canonicalize(project.root())
        .unwrap()
        .to_string_lossy()
        .into_owned();

    let (ok, output) = sfly_dev(project.root(), &socket_of(&agent));
    assert!(ok, "{output}");
    assert!(output.contains("sfly-devpkg@dev"), "{output}");

    // 上报控制面：安装状态 + 开发版本列表（带源码目录和扫描出的节点元信息）。
    let (installed, _) = cp
        .install_status("sfly-devpkg", "dev", InstallState::Installed)
        .await;
    assert_eq!(installed.task_id, "");
    assert_eq!(
        dev_names(&installed.dev_packages),
        vec![("sfly-devpkg".to_string(), source.clone())]
    );
    let metadata: Value = serde_json::from_str(&installed.dev_packages[0].metadata_json).unwrap();
    assert_eq!(metadata["version"], "dev");
    assert_eq!(metadata["nodes"][0]["name"], "about");

    cp.assign(dev_task("task-1", "sfly-devpkg", "about")).await;
    let (result, _) = cp.result("task-1").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    assert_eq!(outputs(&result), json!({ "source": "v1" }));

    // 修改源码后，下一次运行就用新代码（不需要重新 sfly dev）。
    // 标记长度不同：Python 按源文件的 mtime（秒）+ 大小判断 .pyc 是否过期，同一秒内等长的修改看不出来。
    project.write("v2-edited");
    cp.assign(dev_task("task-2", "sfly-devpkg", "about")).await;
    let (result, _) = cp.result("task-2").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    assert_eq!(outputs(&result), json!({ "source": "v2-edited" }));

    // 重新连接时 Hello 也带上开发版本。
    cp.end_session();
    let hello = cp.hello(1).await;
    assert_eq!(
        dev_names(&hello.dev_packages),
        vec![("sfly-devpkg".to_string(), source)]
    );
}

#[tokio::test]
async fn a_dev_task_on_an_agent_that_has_not_loaded_the_dev_package_fails_with_env_error() {
    let fixture = HttpFixture::start().await;
    let venv = fresh_venv(false);
    let cp = FakeControlPlane::start().await;
    let _agent = agent(&cp, "agent-plain", &venv, &fixture);
    cp.hello(0).await;

    // 共享 venv 里装着已发布的 sfly-stub@0.1.0，但没有用 sfly dev 加载过。
    cp.assign(dev_task("task-dev", "sfly-stub", "about")).await;
    let (result, _) = cp.result("task-dev").await;
    assert_eq!(result.status(), TaskStatus::Failed);
    let error = result.error.expect("error");
    assert_eq!(error.kind(), ErrorKind::EnvError);
    assert!(error.message.contains("sfly-stub@dev"), "{}", error.message);
    assert!(error.message.contains("sfly dev"), "{}", error.message);
    assert!(cp.installs().is_empty());
}

#[tokio::test]
async fn published_versions_still_run_published_code_and_dev_comes_back_on_the_next_dev_task() {
    let fixture = HttpFixture::start().await;
    let published = publish(&fixture, "sfly-stub", "0.1.0", &[]);
    let venv = fresh_venv(true);
    let cp = FakeControlPlane::start().await;
    let agent = agent(&cp, "agent-mixed", &venv, &fixture);
    cp.hello(0).await;
    let project = DevProject::new("sfly-stub", "dev-code");
    let (ok, output) = sfly_dev(project.root(), &socket_of(&agent));
    assert!(ok, "{output}");

    cp.assign(dev_task("task-dev-1", "sfly-stub", "about"))
        .await;
    let (result, _) = cp.result("task-dev-1").await;
    assert_eq!(outputs(&result), json!({ "source": "dev-code" }));

    // 锁定已发布版本的任务：切换到已发布版本，执行的是已发布的代码。
    cp.assign(package_task(
        "task-published",
        "sfly-stub",
        "0.1.0",
        "about",
        json!({}),
        published.archive(),
    ))
    .await;
    let (result, _) = cp.result("task-published").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    assert_eq!(
        outputs(&result),
        json!({ "package": "sfly-stub", "version": "0.1.0" })
    );

    // 开发版本仍然注册在这个 Agent 上：下一个 @dev 任务重新装回本地源码。
    cp.assign(dev_task("task-dev-2", "sfly-stub", "about"))
        .await;
    let (result, _) = cp.result("task-dev-2").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    assert_eq!(outputs(&result), json!({ "source": "dev-code" }));
    let reinstalls = cp
        .installs()
        .into_iter()
        .filter(|s| {
            s.version == "dev" && s.task_id == "task-dev-2" && s.state() == InstallState::Installed
        })
        .count();
    assert_eq!(reinstalls, 1);
}

#[tokio::test]
async fn sfly_dev_reports_a_clear_error_when_no_agent_is_listening() {
    let project = DevProject::new("sfly-devpkg", "v1");
    let missing = project.root().join("no-agent.sock");
    let (ok, output) = sfly_dev(project.root(), &missing);
    assert!(!ok);
    assert!(output.contains("Agent"), "{output}");
    assert!(
        output.contains(&missing.to_string_lossy().into_owned()),
        "{output}"
    );
}
