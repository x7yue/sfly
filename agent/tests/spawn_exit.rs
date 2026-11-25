//! Agent 起子进程只有一个出口（#492）：`agent/src/subprocess.rs` 的 `command` 给出已经去掉 Agent 凭据的命令。
//! 以前是每个起进程的地方各自 `env_remove`，漏过一处（`exec.run`）。这条测试扫 `agent/src`：直接起进程的写法
//! （`Command::new(`……）只能出现在出口里和下面写明理由的例外里，次数也要对得上；新加一处不经出口，测试就红。
//! 测试模块（`#[cfg(test)] mod …` 起到文件结尾）不扫。

use std::path::{Path, PathBuf};

/// 直接起进程（或替换进程）的写法。
const PATTERNS: &[&str] = &[
    "Command::new(",
    "Command::from(",
    "CommandExt",
    "fork(",
    "posix_spawn",
    "execv(",
    "execve(",
    "execvp(",
];

/// （文件，写法，次数，理由）：出口本身，和启动 Agent 自己的新版本的两处。
const ALLOWED: [(&str, &str, usize, &str); 3] = [
    (
        "subprocess.rs",
        "Command::new(",
        1,
        "出口：给出已经去掉 Agent 凭据的命令",
    ),
    (
        "update/mod.rs",
        "Command::new(",
        2,
        "自更新：试运行新二进制 `--version`，和用原来的参数 execve 替换自己；起的是 Agent 自己，不是别的程序",
    ),
    (
        "update/mod.rs",
        "CommandExt",
        1,
        "自更新：execve 替换自己（`.exec()`）",
    ),
];

fn sources(dir: &Path, found: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            sources(&path, found);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            found.push(path);
        }
    }
}

/// 文件里测试模块之前的行（去掉整行的注释）。
fn production_lines(text: &str) -> Vec<&str> {
    let lines: Vec<&str> = text.lines().collect();
    let cut = lines
        .windows(2)
        .position(|w| w[0].trim() == "#[cfg(test)]" && w[1].trim_start().starts_with("mod "))
        .unwrap_or(lines.len());
    lines[..cut]
        .iter()
        .copied()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect()
}

#[test]
fn processes_are_only_started_through_the_one_exit_or_the_listed_exceptions() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    sources(&src, &mut files);
    assert!(files.len() > 20, "{files:?}");

    let mut unexpected = Vec::new();
    for path in files {
        let relative = path
            .strip_prefix(&src)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let text = std::fs::read_to_string(&path).unwrap();
        let lines = production_lines(&text);
        for &pattern in PATTERNS {
            let count: usize = lines.iter().map(|l| l.matches(pattern).count()).sum();
            let allowed = ALLOWED
                .iter()
                .find(|(file, p, ..)| *file == relative && *p == pattern)
                .map_or(0, |(_, _, n, _)| *n);
            if count != allowed {
                unexpected.push(format!(
                    "src/{relative}：`{pattern}` 出现 {count} 次，允许 {allowed} 次"
                ));
            }
        }
    }
    assert!(
        unexpected.is_empty(),
        "起进程要经 `subprocess::command`（环境里去掉 Agent 凭据）；确实要直接起的，写进这个测试的 ALLOWED 并写明理由：\n{}",
        unexpected.join("\n")
    );
}

/// 例外列表里的每一项都真的存在（文件改名或删掉写法之后不留过期的例外）。
#[test]
fn every_listed_exception_still_exists() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    for (file, pattern, count, reason) in ALLOWED {
        let text =
            std::fs::read_to_string(src.join(file)).unwrap_or_else(|e| panic!("{file}：{e}"));
        let found: usize = production_lines(&text)
            .iter()
            .map(|l| l.matches(pattern).count())
            .sum();
        assert_eq!(found, count, "{file} `{pattern}`（{reason}）");
    }
}
