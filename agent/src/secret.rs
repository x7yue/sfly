//! 凭据（Agent 凭据）在内存里的包装：`Debug` 不输出内容。
//!
//! Agent 凭据（`--token`、`SFLY_TOKEN`）要原样放进 Hello 和 HTTP 请求的 `Authorization`，所以必须以明文留在内存里；
//! 但配置、命令行参数、请求这些结构体常被 `{:?}` 打印（日志、断言失败、报错），裸的 `String` 会把它连同整个结构体写出去。
//! 包一层之后，不论哪里打印了它所在的结构体，凭据的位置都是 `<redacted>`；用到原值的地方必须显式调用
//! [`Secret::expose`]，读代码时一眼找得全。

use std::convert::Infallible;
use std::fmt;
use std::str::FromStr;

/// Agent 凭据可以经环境变量 `SFLY_TOKEN` 交给 Agent（另一条路是 `agent.env`，由 Agent 自己读）。Agent 起的子进程
/// 都不需要它：执行器（节点的代码）、装依赖的 uv（会运行第三方包的构建脚本）、下载和运行安装脚本的进程。
/// 它们的环境里去掉这个变量（`env_remove`）。这是多一层防护，不是隔离：节点和 Agent 是同一个系统用户，
/// 读得到 `agent.env`（ADR 0029：边界是那台机器）。
pub const CREDENTIAL_ENV: &str = "SFLY_TOKEN";

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

    /// `Secret` 没有 `Display`（`format!("{secret}")`、`to_string()` 会把原值写出去）也不能被序列化
    /// （`serde_json::to_string` 同理）：谁给它加上，这条测试编译不过。
    ///
    /// 做法同 `static_assertions::assert_not_impl_any`：下面的调用在 `Secret` 只有一个候选实现（`()` 那个）时
    /// 能推断出类型；`Secret` 实现了 `Display` 或 `Serialize` 之一，就有两个候选，报「type annotations needed」。
    #[test]
    fn secret_cannot_be_displayed_or_serialized() {
        trait AmbiguousIfImplemented<A> {
            fn check() {}
        }
        impl<T: ?Sized> AmbiguousIfImplemented<()> for T {}
        struct IsDisplay;
        impl<T: ?Sized + fmt::Display> AmbiguousIfImplemented<IsDisplay> for T {}
        struct IsSerialize;
        impl<T: ?Sized + serde::Serialize> AmbiguousIfImplemented<IsSerialize> for T {}

        <Secret as AmbiguousIfImplemented<_>>::check();
    }
}
