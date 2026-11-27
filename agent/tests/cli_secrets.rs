//! 命令行输出里没有凭据（#492）：安装说明让人先 `export SFLY_TOKEN`、再运行 `sfly-agent --help`，
//! 帮助里的 `[env: SFLY_TOKEN=…]` 会把环境变量的值打出来，除非参数声明了 `hide_env_values`。
//! 可能带密码的参数（Agent 凭据，镜像、索引和控制面的地址里可以写 `用户名:密码@`）都要这样声明。
//! 这里逐个设置环境变量，运行 `--help`、`-h`、`--version` 和几种写错参数的调用，输出里没有任何一个原值。

mod support;

use std::process::Command;

use support::{AgentOptions, capture_stderr, spawn_agent, wait_until};

/// 变量名和值：值里都有一个不会出现在帮助正文里的标记。
const SECRETS: [(&str, &str); 5] = [
    ("SFLY_TOKEN", "sfly_agt_0123456789abcdef0123456789abcdef"),
    (
        "SFLY_SERVER",
        "http://serveruser:serverpass-4f1c@cp.invalid:50051",
    ),
    (
        "SFLY_INDEX_URL",
        "https://indexuser:indexpass-7a2d@pypi.invalid/simple",
    ),
    (
        "SFLY_GITHUB_RELEASE_MIRROR",
        "https://mirroruser:mirrorpass-9b3e@mirror.invalid/github-release",
    ),
    (
        "SFLY_PYTHON_INSTALL_MIRROR",
        "https://pythonuser:pythonpass-5c4f@mirror.invalid/python/",
    ),
];

/// 运行 Agent，`args` 之外环境里有 [`SECRETS`] 的每一个；返回标准输出加标准错误。
fn run(args: &[&str]) -> String {
    let home = tempfile::tempdir().unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_sfly-agent"));
    command
        .args(args)
        // 不读开发者自己的 ~/.sfly/agent.env。
        .env("SFLY_HOME", home.path())
        .env("SFLY_AGENT_NAME", "agent-cli-secrets");
    for (name, value) in SECRETS {
        command.env(name, value);
    }
    let output = command.output().unwrap();
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

fn assert_no_secret(output: &str, what: &str) {
    for (name, value) in SECRETS {
        assert!(
            !output.contains(value),
            "{what}：{name} 的原值在输出里：\n{output}"
        );
        // 值里能认出的片段（密码、凭据前缀之后的部分）也不能出现。
        let piece = value
            .split([':', '@', '/'])
            .find(|p| p.contains("pass-") || p.starts_with("sfly_agt_"));
        if let Some(piece) = piece {
            assert!(
                !output.contains(piece),
                "{what}：{name} 的片段 {piece} 在输出里：\n{output}"
            );
        }
    }
}

#[test]
fn help_does_not_print_the_values_of_environment_variables_that_may_hold_credentials() {
    for flag in ["--help", "-h"] {
        let output = run(&[flag]);
        assert!(
            output.contains("--token"),
            "{flag}：没有帮助正文：\n{output}"
        );
        // 环境变量的名字还在（说明参数能从哪个变量读），值不在。
        for (name, _) in SECRETS {
            assert!(
                output.contains(name),
                "{flag}：帮助里没有 {name}：\n{output}"
            );
        }
        assert_no_secret(&output, flag);
    }
}

#[test]
fn version_and_wrong_arguments_do_not_print_them_either() {
    let version = run(&["--version"]);
    assert!(version.starts_with("sfly-agent "), "{version}");
    assert_no_secret(&version, "--version");

    for args in [
        vec!["--no-such-option"],
        vec!["--slots", "0"],
        vec!["--slots", "abc"],
        vec!["--token"],
        vec!["--index-url"],
        vec!["--listen-port", "99999"],
        vec!["stray-positional"],
    ] {
        let output = run(&args);
        assert!(
            output.contains("error:"),
            "{args:?} 应当报参数错误：\n{output}"
        );
        assert_no_secret(&output, &format!("{args:?}"));
    }
}

/// 连不上控制面的报错每次重连写一行（进系统日志）：`--server` 里的用户名和密码不能原样写出来，
/// 漏了协议（`用户名:密码@主机:端口`）的写法也一样。
async fn assert_the_connect_error_has_no_password(server: &str, shown: &str) {
    let mut options = AgentOptions::new(server, "agent-cli-server");
    options.pipe_stderr = true;
    let mut agent = spawn_agent(options);
    let stderr = capture_stderr(&mut agent);
    // 至少写了两次（重连之后又写）。
    wait_until("连不上控制面的报错写了两次", || {
        stderr
            .lock()
            .unwrap()
            .iter()
            .filter(|line| line.contains("cannot connect"))
            .count()
            >= 2
    })
    .await;
    let output = stderr.lock().unwrap().join("\n");
    assert!(
        output.contains(&format!("connect to control plane at {shown}")),
        "{server}：{output}"
    );
    assert!(
        !output.contains("serverpass-4f1c") && !output.contains("serveruser"),
        "{server}：{output}"
    );
}

#[tokio::test]
async fn a_server_address_with_a_password_is_written_without_it_when_the_connection_fails() {
    // 9 号端口（discard）上没有服务：连接被拒绝。
    assert_the_connect_error_has_no_password(
        "http://serveruser:serverpass-4f1c@127.0.0.1:9",
        "http://127.0.0.1:9",
    )
    .await;
}

#[tokio::test]
async fn a_server_address_without_a_scheme_is_written_without_the_password_too() {
    assert_the_connect_error_has_no_password(
        "serveruser:serverpass-4f1c@127.0.0.1:9",
        "127.0.0.1:9",
    )
    .await;
}

/// 控制面地址的凭据里有文字规则认不出的字符（#757）：`--server` 在配置里就登记了，连不上的报错和之后每次重连的报错里都没有。
/// 地址写不成合法的 URI（空格、`"`、`<`、`>`）时连接在解析地址那一步就失败，报错里同样不能有凭据。
#[tokio::test]
async fn a_server_address_with_awkward_password_characters_is_written_without_it_too() {
    for (label, server) in [
        ("双引号", "http://srvuser2:Hd2\"xqTl2yz@127.0.0.1:9"),
        ("空格", "http://srvuser2:Hd2 xqTl2yz@127.0.0.1:9"),
        ("反引号", "http://srvuser2:Hd2`xqTl2yz@127.0.0.1:9"),
        ("小于大于", "http://srvuser2:Hd2<xq>Tl2yz@127.0.0.1:9"),
        (
            "用户名里有反斜杠",
            r"http://SRV2\srvuser2:Hd2xqTl2yz@127.0.0.1:9",
        ),
        ("没写协议", "srvuser2:Hd2\"xqTl2yz@127.0.0.1:9"),
    ] {
        let mut options = AgentOptions::new(server, "agent-cli-server-awkward");
        options.pipe_stderr = true;
        let mut agent = spawn_agent(options);
        let stderr = capture_stderr(&mut agent);
        wait_until(
            &format!("{label}：连不上控制面的报错写了两次"),
            || {
                stderr
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|line| line.contains("cannot connect"))
                    .count()
                    >= 2
            },
        )
        .await;
        let output = stderr.lock().unwrap().join("\n");
        for secret in ["srvuser2", "Hd2", "Tl2yz", "SRV2"] {
            assert!(
                !output.contains(secret),
                "{label}：{secret} 在输出里：{output}"
            );
        }
    }
}
