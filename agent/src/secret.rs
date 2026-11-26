//! 凭据（Agent 凭据）在内存里的包装：`Debug` 不输出内容。
//!
//! Agent 凭据（`--token`、`SFLY_TOKEN`）要原样放进 Hello 和 HTTP 请求的 `Authorization`，所以必须以明文留在内存里；
//! 但配置、命令行参数、请求这些结构体常被 `{:?}` 打印（日志、断言失败、报错），裸的 `String` 会把它连同整个结构体写出去。
//! 包一层之后，不论哪里打印了它所在的结构体，凭据的位置都是 `<redacted>`；用到原值的地方必须显式调用
//! [`Secret::expose`]，读代码时一眼找得全。

use std::borrow::Cow;
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

/// 地址里用户名和密码那一段（`用户名:密码@`）写进日志、失败原因、`Debug` 输出时的替身：固定的一段，不泄露长度。
pub const USERINFO_MASK: &str = "***";

/// 一段文字里每个地址（`协议://…`）的用户名和密码换成 [`USERINFO_MASK`]，主机、端口和路径留着（方便排查）：
/// `https://user:pw@mirror.example/simple` → `https://***@mirror.example/simple`。
///
/// 索引、镜像的地址可以带用户名和密码（私有的索引常这样配，uv 认），而 Agent 把命令行、命令的输出和报错原样写进安装日志、
/// 失败原因、环境准备失败的报告：这些文字里的地址都要经过这里。**对文字整体做**，不要求它是一个地址：命令行的 `Debug`
/// 写法（地址在引号里）、安装工具回显的一行、reqwest 报错里括号里的地址都认。
///
/// 规则：`://` 之后到第一个 `/`、`?`、`#`、空白、引号、反引号、`<`、`>`、`\` 为止是主机那一段（authority），其中最后一个
/// `@` 之前的都是用户名和密码（密码里没有转义的 `@` 也认）；没有 `@` 的原样。路径里的 `@`（`https://host/pkg@1.0`）
/// 不是用户名，不动。已经是掩码的原样（重复处理没有害处）。做不到的：密码里没有转义的 `/`、`?`、`#`（URL 本身就不合法，uv 也不当它是
/// 凭据），以及不是地址形状的凭据（`UV_INDEX_*_PASSWORD` 这样的环境变量的值）。
pub fn mask_userinfo(text: &str) -> Cow<'_, str> {
    let mut masked: Option<String> = None;
    // `text[..copied]` 已经写进 `masked` 了。
    let mut copied = 0;
    let mut from = 0;
    while let Some(found) = text[from..].find("://") {
        let start = from + found + "://".len();
        let end = text[start..]
            .find(|c: char| {
                c.is_whitespace() || matches!(c, '/' | '?' | '#' | '"' | '`' | '<' | '>' | '\\')
            })
            .map_or(text.len(), |i| start + i);
        if let Some(at) = text[start..end].rfind('@')
            && &text[start..start + at] != USERINFO_MASK
        {
            let out = masked.get_or_insert_with(|| String::with_capacity(text.len()));
            out.push_str(&text[copied..start]);
            out.push_str(USERINFO_MASK);
            copied = start + at;
        }
        from = end.max(start);
    }
    match masked {
        Some(mut out) => {
            out.push_str(&text[copied..]);
            Cow::Owned(out)
        }
        None => Cow::Borrowed(text),
    }
}

/// 地址的 `Debug` 和 `Display` 写法：用户名和密码换成 [`USERINFO_MASK`]（[`mask_userinfo`]）。放进手写的 `Debug` 里，
/// 配置、镜像这些带地址的结构体被 `{:?}` 打印时不会把凭据写出去。
pub struct Masked<'a>(pub &'a str);

impl fmt::Debug for Masked<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(&*mask_userinfo(self.0), f)
    }
}

impl fmt::Display for Masked<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&mask_userinfo(self.0))
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

    #[test]
    fn masks_the_username_and_password_of_every_address_in_a_text() {
        for (text, shown) in [
            // 一个地址：主机、端口、路径留着。
            (
                "https://user:pw@mirror.example/simple",
                "https://***@mirror.example/simple",
            ),
            ("http://user:pw@host:8080", "http://***@host:8080"),
            // 只有用户名（令牌当用户名用）也是凭据。
            ("https://token@host/simple/", "https://***@host/simple/"),
            // 密码里有没转义的 @：最后一个 @ 才是分隔。
            ("https://u:p@ss@host/x", "https://***@host/x"),
            // 转义过的照样没有原文。
            ("https://u%40x:p%2Fw@host/x", "https://***@host/x"),
            (
                "https://u:p@[::1]:3141/simple",
                "https://***@[::1]:3141/simple",
            ),
            // 没有凭据的原样：含路径里的 @、查询里的 @、file:// 和没有协议的。
            (
                "https://mirror.example/simple",
                "https://mirror.example/simple",
            ),
            ("https://host/pkg@1.0/x", "https://host/pkg@1.0/x"),
            ("https://host?email=a@b", "https://host?email=a@b"),
            ("https://host#a@b", "https://host#a@b"),
            (
                "file:///mnt/mirror/pypi/simple",
                "file:///mnt/mirror/pypi/simple",
            ),
            ("user:pw@host:1/simple", "user:pw@host:1/simple"),
            ("git@github.com:x/y.git", "git@github.com:x/y.git"),
            ("", ""),
            // 夹在别的文字里：每一个都处理，前后的文字不动。
            (
                "GET https://a:b@one.example/x then https://c:d@two.example:9/y, done",
                "GET https://***@one.example/x then https://***@two.example:9/y, done",
            ),
            // 地址的查询里还有一个地址。
            (
                "http://u:p@h/redirect?to=https://x:y@z/path",
                "http://***@h/redirect?to=https://***@z/path",
            ),
            // 命令行的 Debug 写法（地址和环境变量的值在引号里，没有路径时引号紧跟主机）。
            (
                r#"UV_PYTHON_INSTALL_MIRROR="https://u:p@m.example/py/" "uv" "pip" "--default-index" "https://u:p@m.example""#,
                r#"UV_PYTHON_INSTALL_MIRROR="https://***@m.example/py/" "uv" "pip" "--default-index" "https://***@m.example""#,
            ),
            // shell 写法（单引号）。
            (
                "UV_DOWNLOAD_URL='https://u:p@m.example' curl -fsSL 'https://u:p@m.example/uv.sh'",
                "UV_DOWNLOAD_URL='https://***@m.example' curl -fsSL 'https://***@m.example/uv.sh'",
            ),
            // reqwest 的报错、uv 的报错里括号和反引号里的地址。
            (
                "error sending request for url (http://u:p@127.0.0.1:1/simple/x/)",
                "error sending request for url (http://***@127.0.0.1:1/simple/x/)",
            ),
            (
                "Failed to fetch: `https://u:p@h/simple/x/`",
                "Failed to fetch: `https://***@h/simple/x/`",
            ),
            // 已经是掩码的：再处理一遍不变。
            ("https://***@host/x", "https://***@host/x"),
            // 换行里的多个地址、中文紧跟。
            (
                "镜像：https://u:p@h/a\n另一个：https://v:q@i/b。",
                "镜像：https://***@h/a\n另一个：https://***@i/b。",
            ),
        ] {
            let masked = mask_userinfo(text);
            assert_eq!(masked, shown, "{text}");
            // 再处理一遍不变；没有改动时借用原文，不复制。
            assert_eq!(mask_userinfo(&masked), shown, "{text}（第二遍）");
            if text == shown {
                assert!(matches!(mask_userinfo(text), Cow::Borrowed(_)), "{text}");
            }
        }
    }

    #[test]
    fn masked_addresses_in_debug_and_display_never_show_the_credentials() {
        let address = "https://user:pw-1234@mirror.example/simple";
        assert_eq!(
            format!("{:?}", Masked(address)),
            "\"https://***@mirror.example/simple\""
        );
        assert_eq!(
            format!("{}", Masked(address)),
            "https://***@mirror.example/simple"
        );
        assert_eq!(
            format!("{:?}", Some(Masked(address))),
            "Some(\"https://***@mirror.example/simple\")"
        );
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
