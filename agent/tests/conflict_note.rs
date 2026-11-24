//! 依赖冲突说明（#556、#637、#653）：uv 装不上时，Agent 在 uv 的输出后面补一段，写明哪几个节点包对同一个包的版本要求
//! 不一样。真 uv，桩镜像，造几种装不上的情况，看补出来的说明：该写的写对，不该写的（失败和正在装的版本无关时）
//! 不写，不拿正在装的版本去和别人的要求凑一对。
//!
//! 什么时候把正在装的版本也算一方，靠的是按 PEP 440 算「正在装的版本满不满足别的已装节点包对它的要求」，
//! 不看 uv 的输出提没提到这个包：交给说明的输出第一行是 Agent 自己写的命令行，里面总有这个包的名字（见每个用例）。

mod support;

use std::io::Write as _;
use std::time::Duration;

use serde_json::json;
use sfly_agent::proto::{AssignTask, ErrorKind, TaskStatus};
use support::packages::{
    HttpFixture, build_node_package, dependency_wheel_requiring, fresh_venv, package_task, publish,
    sha256_hex, venv_of,
};
use support::{AgentOptions, AgentProcess, FakeControlPlane, repo_root, spawn_agent};

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

fn add_to_index(fixture: &HttpFixture, name: &str, version: &str, requires: &[&str]) {
    let (filename, wheel) = dependency_wheel_requiring(name, version, requires);
    fixture.add_to_index(name, &filename, wheel, Duration::ZERO);
}

fn task(id: &str, package: &str, version: &str, p: &support::packages::Published) -> AssignTask {
    package_task(id, package, version, "about", json!({}), p.archive())
}

async fn install_ok(cp: &FakeControlPlane, task: AssignTask) {
    let id = task.task_id.clone();
    cp.assign(task).await;
    let (result, _) = cp.result(&id).await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
}

/// 派发任务，等它以 `env_error` 失败，返回完整的错误信息。
async fn install_fails(cp: &FakeControlPlane, task: AssignTask) -> String {
    let id = task.task_id.clone();
    cp.assign(task).await;
    let (result, _) = cp.result(&id).await;
    assert_eq!(result.status(), TaskStatus::Failed, "{result:?}");
    let error = result.error.expect("error");
    assert_eq!(error.kind(), ErrorKind::EnvError);
    error.message
}

/// 错误信息里 Agent 补的那一段（没有补时为空）。
fn note(message: &str) -> &str {
    message.find("依赖冲突：").map_or("", |i| &message[i..])
}

/// 说明里列出的「<谁> 要求 <什么>」的个数。
fn listed(note: &str) -> usize {
    note.lines().filter(|l| l.contains(" 要求 ")).count()
}

/// 把几个节点包的 wheel 不带依赖地装进共享 venv：模拟这台 Agent 的环境已经处在互相矛盾的状态
/// （Agent 自己装的包不会这样，包是后来被别的工具改过的）。
fn install_without_dependencies(venv: &tempfile::TempDir, packages: &[(&str, &[&str])]) {
    let wheels = tempfile::tempdir().unwrap();
    let mut paths = Vec::new();
    for (name, deps) in packages {
        let archive = build_node_package(name, "1.0.0", deps);
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(archive)).unwrap();
        let wheel_name = zip
            .file_names()
            .filter_map(Result::ok)
            .find(|n| n.ends_with(".whl") && !n.contains('/'))
            .unwrap()
            .into_owned();
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(&mut zip.by_name(&wheel_name).unwrap(), &mut bytes).unwrap();
        let path = wheels.path().join(&wheel_name);
        std::fs::write(&path, bytes).unwrap();
        paths.push(path);
    }
    let status = std::process::Command::new("uv")
        .args(["pip", "install", "--no-deps", "--python"])
        .arg(venv_of(venv).join("bin/python"))
        .args(&paths)
        .env("UV_CACHE_DIR", venv.path().join("uv-cache"))
        .env_remove("VIRTUAL_ENV")
        .status()
        .unwrap();
    assert!(status.success());
}

/// 被两个已装节点包挡住的同时，还有一个已装节点包的要求和正在装的版本不冲突：只列真的挡路的。
#[tokio::test]
async fn only_the_requirements_that_exclude_the_version_being_installed_are_listed() {
    let fixture = HttpFixture::start().await;
    add_to_index(&fixture, "sfly-base", "3.0", &[]);
    let u1 = publish(&fixture, "sfly-u1", "1.0.0", &["sfly-base>=2"]);
    let u2 = publish(&fixture, "sfly-u2", "1.0.0", &["sfly-base>=3"]);
    let u3 = publish(&fixture, "sfly-u3", "1.0.0", &["sfly-base>=0.5"]);
    let base = publish(&fixture, "sfly-base", "1.0.0", &[]);
    let venv = fresh_venv(true);
    let cp = FakeControlPlane::start().await;
    let _agent = agent(&cp, "agent-p1", &venv, &fixture);
    cp.hello(0).await;
    install_ok(&cp, task("t-u1", "sfly-u1", "1.0.0", &u1)).await;
    install_ok(&cp, task("t-u2", "sfly-u2", "1.0.0", &u2)).await;
    install_ok(&cp, task("t-u3", "sfly-u3", "1.0.0", &u3)).await;

    let message = install_fails(&cp, task("t-base", "sfly-base", "1.0.0", &base)).await;

    let n = note(&message);
    assert!(
        n.contains("sfly-base@1.0.0（正在装） 要求 sfly-base==1.0.0"),
        "{n}"
    );
    assert!(n.contains("sfly-u1（已安装） 要求 sfly-base>=2"), "{n}");
    assert!(n.contains("sfly-u2（已安装） 要求 sfly-base>=3"), "{n}");
    assert!(!n.contains("sfly-u3"), "{n}");
    assert!(n.contains("怎么办"), "{n}");
}

/// 带环境标记的要求按共享 venv 里实际的解释器判断：这台解释器是 Python 3，`python_version < "3"` 的要求不适用
/// （uv 也不会算它），不列；`python_version >= "3"` 的要求适用，挡路，要列。
#[tokio::test]
async fn a_requirement_with_a_marker_is_judged_by_the_interpreter_of_the_shared_venv() {
    let fixture = HttpFixture::start().await;
    add_to_index(&fixture, "sfly-base", "3.0", &[]);
    let applies = publish(
        &fixture,
        "sfly-applies",
        "1.0.0",
        &["sfly-base>=2 ; python_version >= '3'"],
    );
    let never = publish(
        &fixture,
        "sfly-never",
        "1.0.0",
        &["sfly-base>=3 ; python_version < '3'"],
    );
    let base = publish(&fixture, "sfly-base", "1.0.0", &[]);
    let venv = fresh_venv(true);
    let cp = FakeControlPlane::start().await;
    let _agent = agent(&cp, "agent-marker", &venv, &fixture);
    cp.hello(0).await;
    install_ok(&cp, task("t-applies", "sfly-applies", "1.0.0", &applies)).await;
    install_ok(&cp, task("t-never", "sfly-never", "1.0.0", &never)).await;

    let message = install_fails(&cp, task("t-base", "sfly-base", "1.0.0", &base)).await;

    let n = note(&message);
    assert!(
        n.contains("sfly-applies（已安装） 要求 sfly-base>=2 ; python_version >= '3'"),
        "{n}"
    );
    assert!(!n.contains("sfly-never"), "{n}");
}

/// 两个已装的节点包之间本来就互相矛盾（绕过 Agent 用 --no-deps 装进来的），正在装的包和这场冲突无关，但有一个已装
/// 节点包依赖它（要求和正在装的版本相容）：说明写的是真正矛盾的那两个，不拿正在装的版本凑一对。
#[tokio::test]
async fn installed_packages_that_contradict_each_other_are_not_paired_with_the_unrelated_version() {
    let fixture = HttpFixture::start().await;
    add_to_index(&fixture, "sfly-base", "1.0", &[]);
    add_to_index(&fixture, "sfly-dep", "1.0", &[]);
    let base = publish(&fixture, "sfly-base", "1.0.0", &[]);
    let venv = fresh_venv(true);
    install_without_dependencies(
        &venv,
        &[
            ("sfly-a", &["sfly-dep>=2"]),
            ("sfly-b", &["sfly-dep<2"]),
            ("sfly-user", &["sfly-base>=1"]),
        ],
    );
    let cp = FakeControlPlane::start().await;
    let _agent = agent(&cp, "agent-p2", &venv, &fixture);
    cp.hello(0).await;

    let message = install_fails(&cp, task("t-base", "sfly-base", "1.0.0", &base)).await;

    let n = note(&message);
    assert!(n.contains("sfly-a（已安装） 要求 sfly-dep>=2"), "{n}");
    assert!(n.contains("sfly-b（已安装） 要求 sfly-dep<2"), "{n}");
    assert!(!n.contains("sfly-base"), "{n}");
    assert_eq!(listed(n), 2, "{n}");
}

/// 正在装的包自己的依赖在镜像上没有（不是版本冲突）：没有可写的，不补「依赖冲突」，也没有「怎么办」。
#[tokio::test]
async fn a_dependency_missing_from_the_index_is_not_a_conflict() {
    let fixture = HttpFixture::start().await;
    add_to_index(&fixture, "sfly-base", "1.0", &[]);
    let user = publish(&fixture, "sfly-user", "1.0.0", &["sfly-base>=1"]);
    let base = publish(&fixture, "sfly-base", "1.0.0", &["sfly-missing>=1"]);
    let venv = fresh_venv(true);
    let cp = FakeControlPlane::start().await;
    let _agent = agent(&cp, "agent-p3", &venv, &fixture);
    cp.hello(0).await;
    install_ok(&cp, task("t-user", "sfly-user", "1.0.0", &user)).await;

    let message = install_fails(&cp, task("t-base", "sfly-base", "1.0.0", &base)).await;

    assert!(message.contains("sfly-missing"), "{message}");
    assert!(!message.contains("依赖冲突："), "{message}");
    assert!(!message.contains("怎么办"), "{message}");
}

/// 冲突在正在装的包的依赖上（`sfly-dep`：<2 对 >=2），已装的 `sfly-user` 同时要求正在装的包（`>=1`，相容）：
/// 说明只写 `sfly-dep` 这一对。
#[tokio::test]
async fn a_conflict_on_a_dependency_of_the_package_being_installed_lists_only_that_dependency() {
    let fixture = HttpFixture::start().await;
    add_to_index(&fixture, "sfly-base", "1.0", &[]);
    add_to_index(&fixture, "sfly-dep", "1.0", &[]);
    add_to_index(&fixture, "sfly-dep", "2.0", &[]);
    let user = publish(
        &fixture,
        "sfly-user",
        "1.0.0",
        &["sfly-base>=1", "sfly-dep>=2"],
    );
    let base = publish(&fixture, "sfly-base", "1.0.0", &["sfly-dep<2"]);
    let venv = fresh_venv(true);
    let cp = FakeControlPlane::start().await;
    let _agent = agent(&cp, "agent-p4", &venv, &fixture);
    cp.hello(0).await;
    install_ok(&cp, task("t-user", "sfly-user", "1.0.0", &user)).await;

    let message = install_fails(&cp, task("t-base", "sfly-base", "1.0.0", &base)).await;

    let n = note(&message);
    assert!(
        n.contains("sfly-base@1.0.0（正在装） 要求 sfly-dep<2"),
        "{n}"
    );
    assert!(n.contains("sfly-user（已安装） 要求 sfly-dep>=2"), "{n}");
    assert!(!n.contains("sfly-base==1.0.0"), "{n}");
    assert!(!n.contains("sfly-base>=1"), "{n}");
    assert_eq!(listed(n), 2, "{n}");
}

/// 冲突在两个第三方库各自的依赖上（lib-a 要 sfly-dep>=2，lib-b 要 sfly-dep<2）：节点包这一层没有可列的，
/// 不补说明，uv 的原话原样保留。
#[tokio::test]
async fn a_conflict_between_third_party_libraries_gets_no_note() {
    let fixture = HttpFixture::start().await;
    add_to_index(&fixture, "sfly-dep", "1.0", &[]);
    add_to_index(&fixture, "sfly-dep", "2.0", &[]);
    add_to_index(&fixture, "lib-a", "1.0", &["sfly-dep>=2"]);
    add_to_index(&fixture, "lib-b", "1.0", &["sfly-dep<2"]);
    let user = publish(&fixture, "sfly-user", "1.0.0", &["lib-a"]);
    let new = publish(&fixture, "sfly-new", "1.0.0", &["lib-b"]);
    let venv = fresh_venv(true);
    let cp = FakeControlPlane::start().await;
    let _agent = agent(&cp, "agent-p5", &venv, &fixture);
    cp.hello(0).await;
    install_ok(&cp, task("t-user", "sfly-user", "1.0.0", &user)).await;

    let message = install_fails(&cp, task("t-new", "sfly-new", "1.0.0", &new)).await;

    assert!(message.contains("No solution found"), "{message}");
    assert!(!message.contains("依赖冲突："), "{message}");
}

/// 镜像连不上（`sfly-dep` 的项目页重定向到一个没人监听的端口）：不是依赖解析造成的，不补说明。
#[tokio::test]
async fn an_unreachable_index_gets_no_note() {
    let fixture = HttpFixture::start().await;
    add_to_index(&fixture, "sfly-base", "1.0", &[]);
    let user = publish(&fixture, "sfly-user", "1.0.0", &["sfly-base>=1"]);
    let base = publish(&fixture, "sfly-base", "1.0.0", &["sfly-dep"]);
    fixture.redirect("/simple/sfly-dep/", "http://127.0.0.1:9/simple/sfly-dep/");
    let venv = fresh_venv(true);
    let cp = FakeControlPlane::start().await;
    let _agent = agent(&cp, "agent-p6", &venv, &fixture);
    cp.hello(0).await;
    install_ok(&cp, task("t-user", "sfly-user", "1.0.0", &user)).await;

    let message = install_fails(&cp, task("t-base", "sfly-base", "1.0.0", &base)).await;

    assert!(!message.contains("依赖冲突："), "{message}");
}

/// 归档里的 wheel 是坏的（不是 zip）：读不出版本，不出新的错误，原来的错误不变样，不补说明。
#[tokio::test]
async fn a_broken_wheel_keeps_the_original_error_and_gets_no_note() {
    let fixture = HttpFixture::start().await;
    add_to_index(&fixture, "sfly-base", "1.0", &[]);
    let user = publish(&fixture, "sfly-user", "1.0.0", &["sfly-base>=1"]);
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    zip.start_file(
        "sfly_base-1.0.0-py3-none-any.whl",
        zip::write::SimpleFileOptions::default(),
    )
    .unwrap();
    zip.write_all(b"this is not a zip").unwrap();
    let archive = zip.finish().unwrap().into_inner();
    let sha = sha256_hex(&archive);
    let url = fixture.put("/packages/sfly-base/versions/1.0.0/archive", archive);
    let venv = fresh_venv(true);
    let cp = FakeControlPlane::start().await;
    let _agent = agent(&cp, "agent-p7", &venv, &fixture);
    cp.hello(0).await;
    install_ok(&cp, task("t-user", "sfly-user", "1.0.0", &user)).await;

    let message = install_fails(
        &cp,
        package_task(
            "t-base",
            "sfly-base",
            "1.0.0",
            "about",
            json!({}),
            (&url, &sha),
        ),
    )
    .await;

    assert!(
        message.starts_with("安装节点包 sfly-base@1.0.0 失败（uv "),
        "{message}"
    );
    assert!(!message.contains("依赖冲突："), "{message}");
}

/// `sfly dev` 的开发版本被已装节点包挡住：元数据里写的是带 `+dev` 的版本，读得到，也按 PEP 440 的规矩比较，
/// 所以和别的版本一样写出「正在装」的那一条（`sfly-base@dev（正在装） 要求 sfly-base==<版本>+dev`）。
#[tokio::test]
async fn a_development_version_that_is_blocked_is_listed_with_its_dev_version() {
    let fixture = HttpFixture::start().await;
    add_to_index(&fixture, "sfly-base", "2.0", &[]);
    let user = publish(&fixture, "sfly-user", "1.0.0", &["sfly-base>=2"]);
    let venv = fresh_venv(true);
    let cp = FakeControlPlane::start().await;
    let agent = agent(&cp, "agent-p8", &venv, &fixture);
    cp.hello(0).await;
    install_ok(&cp, task("t-user", "sfly-user", "1.0.0", &user)).await;

    let project = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(project.path().join("src/sfly_base")).unwrap();
    std::fs::write(
        project.path().join("pyproject.toml"),
        "[project]\nname = \"sfly-base\"\nversion = \"1.0.0\"\ndependencies = []\n",
    )
    .unwrap();
    std::fs::write(
        project.path().join("src/sfly_base/__init__.py"),
        "from sfly import node\n\n\n@node\ndef about() -> dict:\n    return {\"source\": \"dev\"}\n",
    )
    .unwrap();
    let socket = agent.work_dir.path().join("agent.sock");
    let output = std::process::Command::new("uv")
        .args(["run", "--locked", "--quiet", "sfly", "dev"])
        .arg(project.path())
        .arg("--socket")
        .arg(&socket)
        .current_dir(repo_root())
        .output()
        .unwrap();
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    assert!(!output.status.success(), "{text}");
    assert!(
        text.contains("sfly-base@dev（正在装） 要求 sfly-base==1.0.0+dev"),
        "{text}"
    );
    assert!(
        text.contains("sfly-user（已安装） 要求 sfly-base>=2"),
        "{text}"
    );
}

/// 已装的节点包很多时说明不会长到几十 KB：最多列 20 对，再多的写还有几对没有列出。
#[tokio::test]
async fn the_note_lists_at_most_twenty_pairs() {
    let fixture = HttpFixture::start().await;
    add_to_index(&fixture, "sfly-base", "3.0", &[]);
    let base = publish(&fixture, "sfly-base", "1.0.0", &[]);
    let venv = fresh_venv(true);
    let names: Vec<String> = (0..22).map(|i| format!("sfly-u{i:02}")).collect();
    install_without_dependencies(
        &venv,
        &names
            .iter()
            .map(|name| (name.as_str(), &["sfly-base>=2"][..]))
            .collect::<Vec<_>>(),
    );
    let cp = FakeControlPlane::start().await;
    let _agent = agent(&cp, "agent-many", &venv, &fixture);
    cp.hello(0).await;

    let message = install_fails(&cp, task("t-base", "sfly-base", "1.0.0", &base)).await;

    let n = note(&message);
    assert_eq!(listed(n), 20, "{n}");
    // 正在装的那一条加 22 个挡路的，一共 23 对，列了 20 对。
    assert!(n.contains("另有 3 对没有列出"), "{n}");
    assert!(n.contains("怎么办"), "{n}");
    assert!(n.len() < 4000, "{}", n.len());
}
