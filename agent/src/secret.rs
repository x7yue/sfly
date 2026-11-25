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
/// 都不需要它，环境里去掉这个变量：所有子进程都经 [`crate::subprocess::command`] 起（执行器、`exec.run` 的命令、
/// 装依赖的 uv、准备环境的进程……），例外只有启动 Agent 自己的新版本。这是多一层防护，不是隔离：节点和 Agent 是同一个
/// 系统用户，读得到 `agent.env`（ADR 0029：边界是那台机器）。
pub const CREDENTIAL_ENV: &str = "SFLY_TOKEN";

/// 写给人看的地址：去掉用户名段（`用户名:密码@`）。`--server` 等地址里可以带用户名和密码，
/// 报错、日志里写地址的地方都经过这里（`agent/tests/cli_secrets.rs` 守着）。没写协议的地址（漏了 `http://`）也一样：
/// 到第一个 `/`、`?`、`#` 为止是主机那一段，去掉其中最后一个 `@` 之前的部分；没有 `@` 的原样返回。
pub fn without_userinfo(address: &str) -> String {
    let (scheme, rest) = match address.split_once("://") {
        Some((scheme, rest)) => (Some(scheme), rest),
        None => (None, address),
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    let Some((_, host)) = authority.rsplit_once('@') else {
        return address.to_string();
    };
    match scheme {
        Some(scheme) => format!("{scheme}://{host}{tail}"),
        None => format!("{host}{tail}"),
    }
}

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

    #[test]
    fn addresses_for_people_have_no_userinfo() {
        for (address, shown) in [
            ("http://127.0.0.1:50051", "http://127.0.0.1:50051"),
            ("http://user:pw@host:1", "http://host:1"),
            ("https://user@host/x?y=a@b#c@d", "https://host/x?y=a@b#c@d"),
            ("http://a:b@c@host:2/p", "http://host:2/p"),
            ("http://u:p@[::1]:3", "http://[::1]:3"),
            ("host:50051", "host:50051"),
            // 没写协议（漏了 `http://`）。
            ("user:pw@host:1", "host:1"),
            ("user:pw@host:1/x", "host:1/x"),
            ("a:b@c@host:2?q=x@y", "host:2?q=x@y"),
            ("host:50051/p@q", "host:50051/p@q"),
            ("", ""),
        ] {
            assert_eq!(without_userinfo(address), shown, "{address}");
        }
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
