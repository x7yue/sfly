//! Agent 的统一目录 `SFLY_HOME`（默认 `~/.sfly`）：
//!
//! ```text
//! $SFLY_HOME/
//!   bin/        Agent 二进制（以及 Agent 管理的 uv）
//!   venv/       共享 venv（--venv 的默认值）
//!   work/       任务工作目录的根目录（--work-dir 的默认值），dev socket 默认是 work/agent.sock
//!   agent.env   配置文件
//! ```
//!
//! `agent.env` 每行一个 `KEY=VALUE`，键是 Agent 对应参数的环境变量名（如 `SFLY_SERVER`、`SFLY_AGENT_NAME`）；
//! 空行和 `#` 开头的行忽略，值两侧的空白去掉，整个值被一对 `"` 或 `'` 包住时去掉引号（不处理转义）。
//! 优先级：命令行参数 > 环境变量 > `agent.env` > 默认值。值为空的行视为没有设置。

use std::path::{Path, PathBuf};

use anyhow::Context as _;

/// 配置文件名。
pub const ENV_FILE: &str = "agent.env";

/// `agent.env` 里给 `sfly` CLI 用的键（控制面 HTTP 地址），Agent 不使用。
pub const CLI_ONLY_KEYS: &[&str] = &["SFLY_CONTROL_PLANE_URL"];

/// `SFLY_HOME`：环境变量 `SFLY_HOME`，否则 `$HOME/.sfly`；两者都没有时为 None。返回绝对路径。
pub fn resolve() -> Option<PathBuf> {
    let home = match std::env::var_os("SFLY_HOME").filter(|v| !v.is_empty()) {
        Some(home) => PathBuf::from(home),
        None => PathBuf::from(std::env::var_os("HOME").filter(|v| !v.is_empty())?).join(".sfly"),
    };
    Some(std::path::absolute(&home).unwrap_or(home))
}

/// 解析 `agent.env` 的内容；格式不对的行记入第二个返回值（行号从 1 开始）。
pub fn parse_env_file(text: &str) -> (Vec<(String, String)>, Vec<usize>) {
    let mut entries = Vec::new();
    let mut invalid = Vec::new();
    for (index, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            invalid.push(index + 1);
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            invalid.push(index + 1);
            continue;
        }
        let value = value.trim();
        let value = ['"', '\'']
            .iter()
            .find_map(|q| {
                value
                    .strip_prefix(*q)
                    .and_then(|v| v.strip_suffix(*q))
                    .filter(|_| value.len() >= 2)
            })
            .unwrap_or(value);
        if !value.is_empty() {
            entries.push((key.to_string(), value.to_string()));
        }
    }
    (entries, invalid)
}

/// 读取 `<home>/agent.env`；文件不存在时为空。格式不对的行在标准错误告警后跳过。
pub fn read_env_file(home: &Path) -> anyhow::Result<Vec<(String, String)>> {
    let path = home.join(ENV_FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
    };
    let (entries, invalid) = parse_env_file(&text);
    for line in invalid {
        eprintln!(
            "ignored line {line} of {}: expected KEY=VALUE",
            path.display()
        );
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::parse_env_file;

    #[test]
    fn parses_comments_quotes_and_blank_values() {
        let (entries, invalid) = parse_env_file(
            "# 注释\n\n SFLY_A = 1 \nSFLY_B=\"two words\"\nSFLY_C='x=y'\nSFLY_D=\nnot a pair\nSFLY_E=\"\n",
        );
        let pairs: Vec<(&str, &str)> = entries
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        assert_eq!(
            pairs,
            [
                ("SFLY_A", "1"),
                ("SFLY_B", "two words"),
                ("SFLY_C", "x=y"),
                ("SFLY_E", "\"")
            ]
        );
        assert_eq!(invalid, [7]);
    }
}
