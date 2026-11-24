//! 凭据（Agent 凭据）在内存里的包装：`Debug` 不输出内容。
//!
//! Agent 凭据（`--token`、`SFLY_TOKEN`）要原样放进 Hello 和 HTTP 请求的 `Authorization`，所以必须以明文留在内存里；
//! 但配置、命令行参数、请求这些结构体常被 `{:?}` 打印（日志、断言失败、报错），裸的 `String` 会把它连同整个结构体写出去。
//! 包一层之后，不论哪里打印了它所在的结构体，凭据的位置都是 `<redacted>`；用到原值的地方必须显式调用
//! [`Secret::expose`]，读代码时一眼找得全。

use std::convert::Infallible;
use std::fmt;
use std::str::FromStr;

#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    /// 原值：只在要放进 Hello 或 `Authorization` 时用。
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

impl From<&str> for Secret {
    fn from(value: &str) -> Self {
        Self(value.to_string())
    }
}

impl From<String> for Secret {
    fn from(value: String) -> Self {
        Self(value)
    }
}

/// clap 用它解析 `--token`、`SFLY_TOKEN`。
impl FromStr for Secret {
    type Err = Infallible;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Ok(Self::from(value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_never_shows_the_value() {
        let secret = Secret::from("sfly_agt_0123456789abcdef");
        assert_eq!(format!("{secret:?}"), "Secret(<redacted>)");
        assert_eq!(format!("{secret:#?}"), "Secret(<redacted>)");
        assert_eq!(
            format!("{:?}", Some(secret.clone())),
            "Some(Secret(<redacted>))"
        );
        assert_eq!(secret.expose(), "sfly_agt_0123456789abcdef");
    }
}
