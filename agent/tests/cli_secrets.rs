//! 命令行输出里没有凭据（#492）：安装说明让人先 `export SFLY_TOKEN`、再运行 `sfly-agent --help`，
//! 帮助里的 `[env: SFLY_TOKEN=…]` 会把环境变量的值打出来，除非参数声明了 `hide_env_values`。
//! 可能带密码的参数（Agent 凭据，镜像、索引和控制面的地址里可以写 `用户名:密码@`）都要这样声明。
//! 这里逐个设置环境变量，运行 `--help`、`-h`、`--version` 和几种写错参数的调用，输出里没有任何一个原值。

use std::process::Command;

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
