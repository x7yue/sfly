//! 控制面的包索引（`Welcome.package_index_url`，#556）：节点包依赖平台自己的包（标准节点包 `sfly-std`）时，
//! Agent 装它的依赖要从控制面的索引取，不能从 PyPI 镜像取，而且没有这个包的 PyPI 镜像、在 PyPI 镜像上有人放了
//! 同名的更高版本、环境变量把 uv 的索引策略换成「选最高版本」时都一样。真实的 uv 和 Agent，控制面和 PyPI 镜像是本地桩。

mod support;

use std::time::Duration;

use prost::Message;
use serde_json::json;
use sfly_agent::proto::{ErrorKind, TaskStatus, Welcome};
use support::packages::{
    HttpFixture, dependency_wheel, fresh_venv, package_task, publish, venv_of,
};
use support::{AgentOptions, AgentProcess, FakeControlPlane, spawn_agent};

/// 控制面上的 sfly-std 版本和 PyPI 镜像上同名的假包的版本。
const PLANE_VERSION: &str = "0.4.0";
const PYPI_VERSION: &str = "9.9.9";

fn add_std(fixture: &HttpFixture, version: &str) -> String {
    let (filename, wheel) = dependency_wheel("sfly-std", version);
    fixture.add_to_index("sfly-std", &filename, wheel, Duration::ZERO);
    format!("/files/{filename}")
}

/// 启动用这个 PyPI 镜像（`--index-url`）和给定环境变量的 Agent；uv 缓存每个测试独立。
fn agent(
    cp: &FakeControlPlane,
    name: &str,
    venv: &tempfile::TempDir,
    pypi: &HttpFixture,
    env: &[(&str, &str)],
) -> AgentProcess {
    let cache = venv.path().join("uv-cache").to_string_lossy().into_owned();
    let venv = venv_of(venv);
    let mut options = AgentOptions::new(&cp.url, name);
    options.venv = &venv;
    options.args = vec!["--index-url".into(), pypi.index_url()];
    options.env = vec![("UV_CACHE_DIR", &cache)];
    options.env.extend_from_slice(env);
    spawn_agent(options)
}

/// 共享 venv 里装的 sfly-std 的版本；没装时为 None。
fn installed_std(venv: &tempfile::TempDir) -> Option<String> {
    let output = std::process::Command::new(venv_of(venv).join("bin/python"))
        .args(["-c", "import sfly_std; print(sfly_std.VERSION)"])
        .output()
        .unwrap();
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[tokio::test]
async fn sfly_std_comes_from_the_control_plane_index_and_everything_else_from_pypi() {
    // PyPI 镜像上没有 sfly-std（它本来就不在 PyPI 上），只有节点包的另一个依赖 sfly-dep。
    let pypi = HttpFixture::start().await;
    let (dep_name, dep) = dependency_wheel("sfly-dep", "1.0");
    pypi.add_to_index("sfly-dep", &dep_name, dep, Duration::ZERO);
    let plane = HttpFixture::start_control_plane().await;
    let std_file = add_std(&plane, PLANE_VERSION);
    let demo = publish(
        &plane,
        "sfly-demo",
        "1.0.0",
        &["sfly-std>=0.3.0", "sfly-dep==1.0"],
    );
    let venv = fresh_venv(true);
    let cp = FakeControlPlane::start().await;
    cp.set_package_index(&plane.index_url());
    let _agent = agent(&cp, "agent-index", &venv, &pypi, &[]);
    cp.hello(0).await;

    cp.assign(package_task(
        "task-1",
        "sfly-demo",
        "1.0.0",
        "about",
        json!({}),
        demo.archive(),
    ))
    .await;

    let (result, _) = cp.result("task-1").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    assert_eq!(installed_std(&venv).as_deref(), Some(PLANE_VERSION));
    assert!(plane.count(&std_file) >= 1, "sfly-std 从控制面的索引下载");
    // 控制面的索引里没有 sfly-dep：404 之后照常去 PyPI 镜像取。
    assert!(pypi.count("/files/sfly_dep-1.0-py3-none-any.whl") >= 1);
}

#[tokio::test]
async fn a_same_named_higher_version_on_pypi_is_never_installed() {
    let pypi = HttpFixture::start().await;
    let fake = add_std(&pypi, PYPI_VERSION);
    let plane = HttpFixture::start_control_plane().await;
    add_std(&plane, PLANE_VERSION);
    let demo = publish(&plane, "sfly-demo", "1.0.0", &["sfly-std>=0.3.0"]);
    let cp = FakeControlPlane::start().await;
    cp.set_package_index(&plane.index_url());

    // 默认的索引策略，以及 Agent 所在的环境里把 uv 的索引策略换成「在所有索引里选最高版本」的情形：
    // Agent 在命令行上写明索引策略，环境变量改不了它。
    for (i, env) in [vec![], vec![("UV_INDEX_STRATEGY", "unsafe-best-match")]]
        .into_iter()
        .enumerate()
    {
        let venv = fresh_venv(true);
        let _agent = agent(&cp, &format!("agent-fake-{i}"), &venv, &pypi, &env);
        cp.hello(i).await;
        let task = format!("task-{i}");
        cp.assign(package_task(
            &task,
            "sfly-demo",
            "1.0.0",
            "about",
            json!({}),
            demo.archive(),
        ))
        .await;
        let (result, _) = cp.result(&task).await;
        assert_eq!(result.status(), TaskStatus::Success, "{env:?}：{result:?}");
        assert_eq!(
            installed_std(&venv).as_deref(),
            Some(PLANE_VERSION),
            "{env:?}"
        );
    }
    assert_eq!(pypi.count(&fake), 0, "PyPI 镜像上的同名包一次也没有下载");
}

#[tokio::test]
async fn without_a_published_version_the_name_is_still_not_taken_from_pypi() {
    let pypi = HttpFixture::start().await;
    let fake = add_std(&pypi, PYPI_VERSION);
    // 控制面还没有发布 sfly-std：索引仍然回答这个名字（一个没有任何版本的页面），而不是 404。
    let plane = HttpFixture::start_control_plane().await;
    plane.put_with(
        "/simple/sfly-std/",
        b"<!DOCTYPE html><html><body></body></html>".to_vec(),
        "text/html",
        Duration::ZERO,
    );
    let demo = publish(&plane, "sfly-demo", "1.0.0", &["sfly-std>=0.3.0"]);
    let venv = fresh_venv(true);
    let cp = FakeControlPlane::start().await;
    cp.set_package_index(&plane.index_url());
    let _agent = agent(&cp, "agent-unpublished", &venv, &pypi, &[]);
    cp.hello(0).await;

    cp.assign(package_task(
        "task-1",
        "sfly-demo",
        "1.0.0",
        "about",
        json!({}),
        demo.archive(),
    ))
    .await;

    let (result, _) = cp.result("task-1").await;
    assert_eq!(result.status(), TaskStatus::Failed);
    let error = result.error.expect("error");
    assert_eq!(error.kind(), ErrorKind::EnvError);
    assert!(error.message.contains("sfly-std"), "{}", error.message);
    assert_eq!(installed_std(&venv), None);
    assert_eq!(pypi.count(&fake), 0, "PyPI 镜像上的同名包一次也没有下载");
}

/// 控制面的包索引对 `sfly-std` 的项目页回 404 或重定向到别处（`SFLY_PUBLIC_URL` 指到了别的 HTTP 服务、反向代理漏转了
/// `/simple/`）：uv 的 first-index 会转去 PyPI 镜像，装上那里的同名包，安装照样成功。Agent 装依赖之前先确认这个地址直接回
/// 200，不是就不装，任务以 env_error 失败，写明地址、得到的状态码（或重定向到哪）和该查什么。
#[tokio::test]
async fn a_package_index_that_does_not_answer_sfly_std_directly_stops_the_install() {
    let pypi = HttpFixture::start().await;
    let fake = add_std(&pypi, PYPI_VERSION);
    let plane = HttpFixture::start_control_plane().await;
    let demo = publish(&plane, "sfly-demo", "1.0.0", &["sfly-std>=0.3.0"]);
    let cp = FakeControlPlane::start().await;
    cp.set_package_index(&plane.index_url());
    let std_page = format!("{}/simple/sfly-std/", plane.url);

    // 第一轮：这个地址上没有 sfly-std 的项目页（404）；第二轮：重定向到 PyPI 镜像的同名项目页。
    for (i, (what, expect)) in [
        ("404", format!("GET {std_page} 返回 404")),
        (
            "重定向",
            format!(
                "GET {std_page} 返回 302 Found，重定向到 {}/simple/sfly-std/",
                pypi.url
            ),
        ),
    ]
    .into_iter()
    .enumerate()
    {
        if i == 1 {
            plane.redirect(
                "/simple/sfly-std/",
                &format!("{}/simple/sfly-std/", pypi.url),
            );
        }
        let venv = fresh_venv(true);
        let _agent = agent(&cp, &format!("agent-check-{i}"), &venv, &pypi, &[]);
        cp.hello(i).await;
        let task = format!("task-{i}");
        cp.assign(package_task(
            &task,
            "sfly-demo",
            "1.0.0",
            "about",
            json!({}),
            demo.archive(),
        ))
        .await;

        let (result, _) = cp.result(&task).await;
        assert_eq!(result.status(), TaskStatus::Failed, "{what}：{result:?}");
        let error = result.error.expect("error");
        assert_eq!(error.kind(), ErrorKind::EnvError, "{what}");
        assert!(error.message.contains(&expect), "{what}：{}", error.message);
        assert!(
            error.message.contains("SFLY_PUBLIC_URL") && error.message.contains("/simple/"),
            "{what}：说明要查什么：{}",
            error.message
        );
        assert_eq!(installed_std(&venv), None, "{what}：没有装上任何 sfly-std");
    }
    assert_eq!(pypi.count(&fake), 0, "PyPI 镜像上的同名包一次也没有下载");
    assert_eq!(
        pypi.count("/simple/sfly-std/"),
        0,
        "PyPI 镜像的项目页一次也没有被问到：没有跟随重定向，也没有交给 uv"
    );
}

/// 只看状态码拦不住最要紧的那种配错：对外地址指到了一个 PyPI 风格的索引（镜像），那里**有**同名的更高版本，回 200。
/// uv 会装上它。所以 Agent 还要求控制面的标记头 `x-sfly-package-index`（值非空）：没有就不装，任务以 env_error 失败，
/// 写明「这个地址回了 200 但不是 sfly 控制面的包索引」。（标记头防的是配错，不是有意伪造。）
#[tokio::test]
async fn a_200_without_the_control_planes_marker_stops_the_install() {
    let pypi = HttpFixture::start().await;
    // 没有标记头，和值为空：都不算。
    for (i, marker) in [None, Some("")].into_iter().enumerate() {
        // 对外地址上是一个 PyPI 风格的索引，同一路径上有同名的更高版本，回 200。
        let imposter = HttpFixture::start_with_marker(marker).await;
        let fake = add_std(&imposter, PYPI_VERSION);
        let plane = HttpFixture::start_control_plane().await;
        let demo = publish(&plane, "sfly-demo", "1.0.0", &["sfly-std>=0.3.0"]);
        let venv = fresh_venv(true);
        let cp = FakeControlPlane::start().await;
        cp.set_package_index(&imposter.index_url());
        let _agent = agent(&cp, &format!("agent-imposter-{i}"), &venv, &pypi, &[]);
        cp.hello(0).await;

        cp.assign(package_task(
            "task-1",
            "sfly-demo",
            "1.0.0",
            "about",
            json!({}),
            demo.archive(),
        ))
        .await;

        let (result, _) = cp.result("task-1").await;
        assert_eq!(
            result.status(),
            TaskStatus::Failed,
            "{marker:?}：{result:?}"
        );
        let error = result.error.expect("error");
        assert_eq!(error.kind(), ErrorKind::EnvError, "{marker:?}");
        for expected in [
            format!("GET {}/simple/sfly-std/ 返回 200", imposter.url),
            "x-sfly-package-index".to_string(),
            "这个地址回了 200 但不是 sfly 控制面的包索引".to_string(),
            "SFLY_PUBLIC_URL".to_string(),
        ] {
            assert!(
                error.message.contains(&expected),
                "{marker:?}：{expected}：{}",
                error.message
            );
        }
        assert_eq!(
            installed_std(&venv),
            None,
            "{marker:?}：没有装上任何 sfly-std"
        );
        assert_eq!(imposter.count(&fake), 0, "{marker:?}：假包一次也没有下载");
        assert_eq!(
            imposter.count("/simple/sfly-std/"),
            1,
            "{marker:?}：只有检查问过一次，没有交给 uv"
        );
    }
}

/// 每次装依赖都先问，不只在节点包的要求里直接写了 `sfly-std` 时：它多半是传递依赖，装之前看不出来。
#[tokio::test]
async fn every_install_checks_the_index_even_for_a_package_that_does_not_mention_sfly_std() {
    let pypi = HttpFixture::start().await;
    let plane = HttpFixture::start_control_plane().await;
    let plain = publish(&plane, "sfly-plain", "1.0.0", &[]);
    let venv = fresh_venv(true);
    let cp = FakeControlPlane::start().await;
    cp.set_package_index(&plane.index_url());
    let _agent = agent(&cp, "agent-check-plain", &venv, &pypi, &[]);
    cp.hello(0).await;

    cp.assign(package_task(
        "task-1",
        "sfly-plain",
        "1.0.0",
        "about",
        json!({}),
        plain.archive(),
    ))
    .await;

    let (result, _) = cp.result("task-1").await;
    assert_eq!(result.status(), TaskStatus::Failed, "{result:?}");
    let error = result.error.expect("error");
    assert_eq!(error.kind(), ErrorKind::EnvError);
    assert!(
        error
            .message
            .contains(&format!("GET {}/simple/sfly-std/ 返回 404", plane.url)),
        "{}",
        error.message
    );
}

/// 一台 Agent 的共享 venv 里只有一个 sfly-std：两个节点包要求的版本互相矛盾时，装第二个失败，任务错误里除了 uv 的输出，
/// 还写明是哪两个包、各要什么版本（uv 只说「你要求 sfly-std<0.4」，不说是哪个包要求的）。
#[tokio::test]
async fn contradicting_sfly_std_requirements_name_both_packages_and_what_each_requires() {
    let pypi = HttpFixture::start().await;
    let plane = HttpFixture::start_control_plane().await;
    add_std(&plane, "0.3.0");
    add_std(&plane, PLANE_VERSION);
    let old = publish(&plane, "sfly-old", "1.0.0", &["sfly-std<0.4"]);
    let new = publish(&plane, "sfly-new", "1.0.0", &["sfly-std>=0.4"]);
    let venv = fresh_venv(true);
    let cp = FakeControlPlane::start().await;
    cp.set_package_index(&plane.index_url());
    let _agent = agent(&cp, "agent-contradiction", &venv, &pypi, &[]);
    cp.hello(0).await;

    cp.assign(package_task(
        "task-old",
        "sfly-old",
        "1.0.0",
        "about",
        json!({}),
        old.archive(),
    ))
    .await;
    let (result, _) = cp.result("task-old").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    assert_eq!(installed_std(&venv).as_deref(), Some("0.3.0"));

    cp.assign(package_task(
        "task-new",
        "sfly-new",
        "1.0.0",
        "about",
        json!({}),
        new.archive(),
    ))
    .await;
    let (result, _) = cp.result("task-new").await;
    assert_eq!(result.status(), TaskStatus::Failed, "{result:?}");
    let error = result.error.expect("error");
    assert_eq!(error.kind(), ErrorKind::EnvError);
    assert!(
        error.message.contains("No solution found"),
        "uv 的输出照常带着：{}",
        error.message
    );
    assert!(
        error
            .message
            .contains("sfly-new@1.0.0（正在装） 要求 sfly-std>=0.4"),
        "{}",
        error.message
    );
    assert!(
        error
            .message
            .contains("sfly-old（已安装） 要求 sfly-std<0.4"),
        "{}",
        error.message
    );
    // 失败的安装没有动共享 venv。
    assert_eq!(installed_std(&venv).as_deref(), Some("0.3.0"));
}

/// 新 Agent 连旧版本的控制面：Welcome 没有 `package_index_url`（空串），Agent 不加这个索引，依赖只来自 PyPI 镜像，
/// 和以前一样：PyPI 镜像上有 sfly-std 就装它，没有就是 uv 的「找不到」，任务以 env_error 失败。
#[tokio::test]
async fn welcome_without_a_package_index_behaves_as_before() {
    let plane = HttpFixture::start_control_plane().await;
    let demo = publish(&plane, "sfly-demo", "1.0.0", &["sfly-std>=0.3.0"]);
    let cp = FakeControlPlane::start().await;
    cp.set_package_index("");

    let without = HttpFixture::start().await;
    let venv = fresh_venv(true);
    let _first = agent(&cp, "agent-old-cp-1", &venv, &without, &[]);
    cp.hello(0).await;
    cp.assign(package_task(
        "task-1",
        "sfly-demo",
        "1.0.0",
        "about",
        json!({}),
        demo.archive(),
    ))
    .await;
    let (result, _) = cp.result("task-1").await;
    assert_eq!(result.status(), TaskStatus::Failed, "{result:?}");
    let error = result.error.expect("error");
    assert_eq!(error.kind(), ErrorKind::EnvError);
    assert!(error.message.contains("sfly-std"), "{}", error.message);

    let with = HttpFixture::start().await;
    add_std(&with, PYPI_VERSION);
    let venv = fresh_venv(true);
    let _second = agent(&cp, "agent-old-cp-2", &venv, &with, &[]);
    cp.hello(1).await;
    cp.assign(package_task(
        "task-2",
        "sfly-demo",
        "1.0.0",
        "about",
        json!({}),
        demo.archive(),
    ))
    .await;
    let (result, _) = cp.result("task-2").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    assert_eq!(installed_std(&venv).as_deref(), Some(PYPI_VERSION));
}

/// 旧 Agent 连新版本的控制面：旧 Agent 的 `Welcome` 没有第 10 个字段，protobuf 解码时忽略它，其余字段照常读出
/// （字段只增不改；旧 Agent 不装控制面的索引，所以依赖 sfly-std 的节点包在它上面和以前一样装不上，
/// 而控制面不给版本和自己不一致的 Agent 派任务：Agent 先自更新到控制面的版本，见 Welcome.target_agent_version）。
#[test]
fn a_welcome_with_a_package_index_still_decodes_for_an_agent_that_does_not_know_the_field() {
    /// 加这个字段之前的 `Welcome`（字段 1 到 9）。
    #[derive(Clone, PartialEq, prost::Message)]
    struct WelcomeBefore {
        #[prost(string, tag = "3")]
        sdk_wheel_url: String,
        #[prost(string, tag = "5")]
        pypi_mirror: String,
        #[prost(string, tag = "7")]
        target_agent_version: String,
        #[prost(string, tag = "9")]
        agent_binary_sha256: String,
    }
    let new = Welcome {
        sdk_wheel_url: "http://plane/sdk/python/0.6.0/sfly-0.6.0-py3-none-any.whl".into(),
        pypi_mirror: "https://mirror.example/simple".into(),
        target_agent_version: "0.6.0".into(),
        agent_binary_sha256: "abc".into(),
        package_index_url: "http://plane/simple/".into(),
        ..Default::default()
    };
    let old = WelcomeBefore::decode(new.encode_to_vec().as_slice()).expect("旧 Agent 能解码");
    assert_eq!(old.sdk_wheel_url, new.sdk_wheel_url);
    assert_eq!(old.pypi_mirror, new.pypi_mirror);
    assert_eq!(old.target_agent_version, "0.6.0");
    assert_eq!(old.agent_binary_sha256, "abc");
}
