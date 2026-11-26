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
use std::sync::{PoisonError, RwLock};

use url::Url;

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

// ---- 已知的地址：按值打码（#757）----
//
// 文字规则只在一段文字里「找」地址，凭据里有它认不出的字符（空白、`"`、反引号、`<`、`>`、`\`：URL 解析器和 uv 都接受，
// 启动检查也放行）时，用户名和密码原样留在日志里；命令行的 `Debug` 写法还把 `"` 写成 `\"`。所以 Agent 自己知道的、可能带凭据的
// 地址（`--server`、`--index-url`、`--github-release-mirror`、`--python-install-mirror`，和 Welcome 里控制面下发的几个地址）
// 登记在这里：登记时按**单个地址**算出「这个地址带凭据时的原文」在日志里会有的几种写法，之后 [`mask_userinfo`] 在文字里
// 找到这些写法的完整出现就整段换掉。

/// 登记表最多留多少个地址（去重；满了丢掉最早的）：Welcome 每次重连都会再给，同一个值只占一项，不会涨。
const MAX_KNOWN_ADDRESSES: usize = 64;

/// 文字里的 `needle`（一个地址带凭据的某种写法的完整出现）换成 `replacement`。
#[derive(Clone, PartialEq, Eq)]
struct Rule {
    needle: String,
    replacement: String,
}

#[derive(Default)]
struct Registry {
    /// 登记过的地址和它们各自的规则，按登记的先后。
    entries: Vec<(String, Vec<Rule>)>,
    /// 全部规则，needle 长的在前：先换长的，短的是长的的一部分时不会剩一截。
    rules: Vec<Rule>,
}

impl Registry {
    fn add(&mut self, address: String, rules: Vec<Rule>) {
        if self.entries.iter().any(|(known, _)| *known == address) {
            return;
        }
        if self.entries.len() >= MAX_KNOWN_ADDRESSES {
            self.entries.remove(0);
        }
        self.entries.push((address, rules));
        self.rules = self
            .entries
            .iter()
            .flat_map(|(_, rules)| rules.iter().cloned())
            .collect();
        self.rules
            .sort_by_key(|rule| std::cmp::Reverse(rule.needle.len()));
    }
}

static KNOWN: RwLock<Registry> = RwLock::new(Registry {
    entries: Vec::new(),
    rules: Vec::new(),
});

/// 登记一个地址：它带用户名和密码时，之后写进日志的文字里它的原文按值换成掩码（[`mask_userinfo`]）。不带凭据的地址
/// （没有 `@`、`file://`、路径）什么也不登记。可以重复登记同一个地址。
///
/// 登记的是 Agent 自己知道的地址：配置里的（[`crate::Config`]）和控制面在 Welcome 里下发的
/// （[`crate::environment::Mirrors::new`] 之前，[`crate::connect`] 一收到 Welcome 就登记）；**要在第一次写这个地址之前登记**。
pub fn register_address(address: &str) {
    let rules = known_rules(address);
    if rules.is_empty() {
        return;
    }
    let mut registry = KNOWN.write().unwrap_or_else(PoisonError::into_inner);
    registry.add(address.to_string(), rules);
}

/// 文字里已知地址带凭据的写法的完整出现，换成登记时算好的替身；没有出现时原样借用。
fn mask_known(text: &str) -> Cow<'_, str> {
    let registry = KNOWN.read().unwrap_or_else(PoisonError::into_inner);
    let mut masked: Option<String> = None;
    for Rule {
        needle,
        replacement,
    } in &registry.rules
    {
        let current = masked.as_deref().unwrap_or(text);
        if current.contains(needle.as_str()) {
            masked = Some(current.replace(needle.as_str(), replacement));
        }
    }
    masked.map_or(Cow::Borrowed(text), Cow::Owned)
}

/// 一个地址带凭据时，它在日志里会有的写法（按单个地址的规则算，不看文字）：
///
/// - **读法一致**（URL 解析器和 curl 读出同一个用户名和密码）：主机段（`://` 之后到第一个 `/`、`?`、`#` 为止）里最后一个 `@`
///   之前是凭据。写法有：`://凭据@`（换成 `://***@`）和 `凭据@主机`（换成 `***@主机`，没写协议或日志里去掉了协议）；
///   URL 解析器写出来的写法（`Url` 把凭据里的空格、`"`、`<`、`>` 等百分号编码，tab 和换行去掉，主机小写、默认端口去掉：
///   uv、reqwest 打印的地址就是它）另算一份。
/// - **读法不一致**（用户名密码段里有 `\`：URL 解析器在 `\` 处结束主机段，主机是 `\` 之前的、读不出凭据，凭据落进了路径；
///   curl 不把 `\` 当分隔符，读成用户名和密码，#756）：认不准凭据在哪，**整个地址不写出来**，整段换成 `***`
///   （原文、URL 解析器写出来的写法、去掉末尾 `/` 的写法，这样「地址加上路径」也认得出）。读法一致的那几种写法也一并登记。
///
/// 每种写法再加两个转义的版本：命令行的 `Debug` 写法（`"` 写成 `\"`，`\` 写成 `\\`）和 shell 的单引号写法（`'` 写成 `'\''`，
/// [`crate::environment`] 打印失败的命令用它）。
fn known_rules(address: &str) -> Vec<Rule> {
    // 配置里的地址原样用，Welcome 里的去掉了首尾空白（`environment::non_empty`）：两种都登记。
    let trimmed = address.trim();
    let mut candidates = vec![address];
    if trimmed != address {
        candidates.push(trimmed);
    }
    let mut rules = Vec::new();
    for candidate in candidates {
        // 没有 `@` 就没有用户名密码段（`%40` 不是分隔符）。
        if candidate.contains('@') {
            rules_of_one(candidate, &mut rules);
        }
    }
    let mut all: Vec<Rule> = Vec::new();
    for rule in &rules {
        for variant in with_escapes(rule) {
            if variant.needle.len() >= MIN_NEEDLE && !all.contains(&variant) {
                all.push(variant);
            }
        }
    }
    all
}

/// 比 `://x@` 还短的写法不登记：这样短的一段文字太容易是巧合。
const MIN_NEEDLE: usize = 5;

fn rules_of_one(address: &str, rules: &mut Vec<Rule>) {
    let rest = address.split_once("://").map_or(address, |(_, rest)| rest);
    // curl、wget 的读法：主机段到第一个 `/`、`?`、`#` 为止（`\` 是主机段的一部分）；URL 解析器（WHATWG）的读法：`\` 也结束主机段。
    let curl_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let url_end = rest.find(['/', '\\', '?', '#']).unwrap_or(rest.len());
    let curl_authority = &rest[..curl_end];
    let curl = curl_authority.rsplit_once('@');
    let url_reading = rest[..url_end].rsplit_once('@');
    let parsed = Url::parse(address).ok();

    let add = |rules: &mut Vec<Rule>, needle: String, replacement: String| {
        rules.push(Rule {
            needle,
            replacement,
        });
    };
    let consistent =
        curl.map(|(userinfo, _)| userinfo) == url_reading.map(|(userinfo, _)| userinfo);
    if let Some((userinfo, host)) = curl
        && !userinfo.is_empty()
        && userinfo != USERINFO_MASK
    {
        add(
            rules,
            format!("://{userinfo}@"),
            format!("://{USERINFO_MASK}@"),
        );
        add(
            rules,
            curl_authority.to_string(),
            format!("{USERINFO_MASK}@{host}"),
        );
    }
    // URL 解析器写出来的写法：凭据百分号编码、主机规范化之后。
    if let Some(url) = &parsed {
        let userinfo = url
            .authority()
            .rsplit_once('@')
            .map(|(userinfo, _)| userinfo);
        if let Some(userinfo) = userinfo
            && !userinfo.is_empty()
            && userinfo != USERINFO_MASK
        {
            let host = &url.authority()[userinfo.len() + 1..];
            add(
                rules,
                format!("://{userinfo}@"),
                format!("://{USERINFO_MASK}@"),
            );
            add(
                rules,
                url.authority().to_string(),
                format!("{USERINFO_MASK}@{host}"),
            );
        }
    }
    if !consistent {
        // 整个地址不写出来：原文，和 URL 解析器写出来的（凭据落进了路径）；都去掉末尾的 `/`，加上路径的写法也认得出。
        let mut whole = vec![address.trim_end_matches('/').to_string()];
        if let Some(url) = &parsed {
            whole.push(url.as_str().trim_end_matches('/').to_string());
        }
        for needle in whole {
            add(rules, needle, USERINFO_MASK.to_string());
        }
    }
}

/// 一条规则在日志里的三种写法：原样、命令行 `Debug` 的转义、shell 单引号的转义。
fn with_escapes(rule: &Rule) -> Vec<Rule> {
    let debug = |text: &str| {
        let quoted = format!("{text:?}");
        quoted[1..quoted.len() - 1].to_string()
    };
    let shell = |text: &str| text.replace('\'', r"'\''");
    vec![
        rule.clone(),
        Rule {
            needle: debug(&rule.needle),
            replacement: debug(&rule.replacement),
        },
        Rule {
            needle: shell(&rule.needle),
            replacement: shell(&rule.replacement),
        },
    ]
}

/// 文字规则（[`mask_userinfo`] 的兜底）：一段文字里每个地址（`协议://…`）的用户名和密码换成 [`USERINFO_MASK`]，主机、端口和路径留着（方便排查）：
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
fn mask_by_text(text: &str) -> Cow<'_, str> {
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

/// 写进日志、失败原因、报告、`Debug` 输出的文字里的地址：用户名和密码换成 [`USERINFO_MASK`]，主机、端口和路径留着（方便排查）：
/// `https://user:pw@mirror.example/simple` → `https://***@mirror.example/simple`。**这些文字都要经过这里。**
///
/// 两层，先按值、再按文字：
///
/// 1. **已知的地址按值**（[`register_address`]：Agent 自己配置的和控制面下发的控制面地址、镜像地址）：文字里这些地址带凭据的
///    原文（连同它们在命令行的 `Debug` 写法、shell 的单引号写法、URL 解析器写出来的写法）整段换成去掉凭据的写法。
///    **只认完整的出现**：文字里没有某个地址的某种写法的完整一段，输出就和这一层不存在时一样，不看有没有部分相同
///    （TEAM.md「打码的规矩」、#529：不能让能触发运行又读得到结果的人一位一位地试出凭据）。不依赖凭据里是什么字符：
///    密码里有空白、`"`、反引号、`<`、`>`、`\` 都认（URL 解析器和 uv 接受它们），文字规则认不出的就是这些。
/// 2. **文字规则**（[`mask_by_text`]）兜底：文字里没登记过的地址（uv 打印的别的地址、重定向）也要处理。
pub fn mask_userinfo(text: &str) -> Cow<'_, str> {
    match mask_known(text) {
        Cow::Borrowed(text) => mask_by_text(text),
        Cow::Owned(replaced) => Cow::Owned(mask_by_text(&replaced).into_owned()),
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

    // ---- 已知的地址按值打码（#757）----
    //
    // 全局的登记表被所有测试共用：每个测试用只属于它的用户名、主机和记号，别的测试登记的地址不会碰到它的文字。

    /// 文字里还有没有这些片段（凭据的整段、记号）。
    fn leaked<'a>(text: &str, secrets: &[&'a str]) -> Vec<&'a str> {
        secrets
            .iter()
            .copied()
            .filter(|secret| text.contains(secret))
            .collect()
    }

    /// 一个地址在日志里的各种写法：原文、命令行 `Debug`、shell 单引号、URL 解析器写出来的、后面接着路径。
    fn spellings(address: &str) -> Vec<(&'static str, String)> {
        let shell = |text: &str| format!("'{}'", text.replace('\'', r"'\''"));
        let mut all = vec![
            ("原文", format!("GET {address} failed")),
            (
                "命令行的 Debug",
                format!("{:?}", ["uv", "--default-index", address]),
            ),
            (
                "shell 的单引号",
                format!("curl -fsSL {} -o x", shell(address)),
            ),
            (
                "后面接着路径",
                format!("{}/astral-sh/uv/x.tar.gz", address.trim_end_matches('/')),
            ),
            (
                "环境变量的 Debug",
                format!(
                    "{:?}",
                    std::process::Command::new("sh").env("UV_DOWNLOAD_URL", address)
                ),
            ),
        ];
        if let Ok(url) = Url::parse(address) {
            all.push((
                "URL 解析器写出来的",
                format!("error sending request for url ({url})"),
            ));
        }
        all
    }

    /// 密码里有文字规则认不出的字符，而 URL 解析器、uv 接受：`"`、空格、反引号、`<`、`>`。
    #[test]
    fn a_registered_address_is_masked_by_value_whatever_characters_the_password_has() {
        for (index, (label, middle)) in [
            ("双引号", "\""),
            ("空格", " "),
            ("反引号", "`"),
            ("小于号", "<"),
            ("大于号", ">"),
            ("引号和空格和单引号", "\" '"),
            ("制表符", "\t"),
        ]
        .into_iter()
        .enumerate()
        {
            let password = format!("Hd{index}xq{middle}Tl{index}yz");
            let address =
                format!("https://reguser{index}:{password}@mirror-r{index}.example:8443/simple");
            register_address(&address);
            let secrets = [
                password.as_str(),
                &format!("Hd{index}xq"),
                &format!("Tl{index}yz"),
            ];
            for (form, text) in spellings(&address) {
                let masked = mask_userinfo(&text);
                assert_eq!(
                    leaked(&masked, &secrets),
                    Vec::<&str>::new(),
                    "{label}，{form}：{masked}"
                );
                assert!(
                    !masked.contains(&format!("reguser{index}")),
                    "{label}，{form}：用户名也不留：{masked}"
                );
                // 主机和路径留着（方便排查），凭据的位置是掩码。
                assert!(
                    masked.contains(&format!("mirror-r{index}.example")),
                    "{label}，{form}：{masked}"
                );
                assert!(masked.contains("***"), "{label}，{form}：{masked}");
            }
        }
    }

    #[test]
    fn a_registered_address_keeps_its_scheme_host_port_and_path() {
        let address = r#"https://hostuser:Hd9"xq Tl9yz@mirror-keep.example:8443/simple"#;
        register_address(address);

        assert_eq!(
            mask_userinfo(&format!("fetching {address}/pkg/ now")),
            "fetching https://***@mirror-keep.example:8443/simple/pkg/ now"
        );
        assert_eq!(
            format!("{:?}", Masked(address)),
            "\"https://***@mirror-keep.example:8443/simple\""
        );
        assert_eq!(
            format!("{}", Masked(address)),
            "https://***@mirror-keep.example:8443/simple"
        );
    }

    #[test]
    fn the_username_alone_and_a_scheme_less_address_are_masked_too() {
        // 只有用户名（令牌当用户名用）。
        let token = r#"https://Tk5"xq Zz5yz@token-only.example/simple/"#;
        register_address(token);
        let text = format!("see {token} and {:?}", [token]);
        let masked = mask_userinfo(&text);
        assert!(
            !masked.contains("Tk5") && !masked.contains("Zz5yz"),
            "{masked}"
        );
        assert!(masked.contains("https://***@token-only.example/simple/"));
        // 漏了协议的地址（`--server` 写成 `用户名:密码@主机:端口`）：日志里可能加上协议，也可能不加。
        let schemeless = r#"sluser6:Hd6"xq Tl6yz@schemeless.example:50051"#;
        register_address(schemeless);
        for text in [
            format!("connect to {schemeless}"),
            format!("connect to http://{schemeless}"),
            format!("{:?}", [schemeless]),
        ] {
            let masked = mask_userinfo(&text);
            assert!(
                !masked.contains("sluser6") && !masked.contains("Hd6") && !masked.contains("Tl6yz"),
                "{masked}"
            );
            assert!(masked.contains("***@schemeless.example:50051"), "{masked}");
        }
    }

    /// 单引号在 shell 写法里是 `'\''`，在命令行的 `Debug` 里不转义。
    #[test]
    fn a_single_quote_in_the_password_is_masked_in_the_shell_and_debug_spellings() {
        let address = "https://squser7:Hd7'xqTl7yz@single-quote.example/simple";
        register_address(address);
        for (form, text) in spellings(address) {
            let masked = mask_userinfo(&text);
            assert!(
                !masked.contains("Hd7") && !masked.contains("Tl7yz") && !masked.contains("squser7"),
                "{form}：{masked}"
            );
        }
    }

    /// `\` 在用户名位置或密码里：URL 解析器在 `\` 处结束主机段（凭据落进路径），curl 不当它是分隔符（读成凭据）。
    /// 读法不一致，认不准凭据在哪：整个地址不写出来（#756 的四种写法）。
    #[test]
    fn an_address_the_two_readings_disagree_on_is_not_written_out_at_all() {
        for (index, (label, address, secrets)) in [
            (
                "AD 风格的 域\\用户名",
                r"https://CORP8\jdoe8:Sec8q@nexus-8.corp/github-release",
                &["CORP8", "jdoe8", "Sec8q"][..],
            ),
            (
                "数字加 \\ 的密码",
                r"https://deploy9:1234\abc9@mirror-9.corp/simple",
                &["deploy9", "1234\\abc9", "abc9"][..],
            ),
            (
                "带 \\ 的令牌",
                r"https://tok10\en10@mirror-10.corp/simple",
                &["tok10", "en10"][..],
            ),
            (
                "\\ 在用户名之前",
                r"https://mirror-11.corp\u11:Sec11q@evil-11.example/simple",
                &["u11", "Sec11q"][..],
            ),
        ]
        .into_iter()
        .enumerate()
        {
            register_address(address);
            for (form, text) in spellings(address) {
                let masked = mask_userinfo(&text);
                assert_eq!(
                    leaked(&masked, secrets),
                    Vec::<&str>::new(),
                    "{label}，{form}：{masked}"
                );
                assert!(masked.contains("***"), "{label}，{form}：{masked}");
            }
            // 地址不带路径、不带末尾的 `/` 时也一样。
            let text = format!("mirror {} end", address.trim_end_matches('/'));
            let no_slash = mask_userinfo(&text);
            assert_eq!(
                leaked(&no_slash, secrets),
                Vec::<&str>::new(),
                "{index} {label}"
            );
        }
    }

    /// 只认完整的出现：文字里只有凭据的一部分、或者别的用户名，输出一个字符都不变（不借文字规则以外的任何东西）。
    #[test]
    fn only_a_complete_occurrence_of_a_registered_address_changes_the_text() {
        let address = r#"https://fulluser12:Hd12"xq Tl12yz@full-only.example/simple"#;
        register_address(address);
        for text in [
            // 凭据的一部分，不带 `@` 和主机。
            "Hd12\"xq Tl12yz".to_string(),
            "password is Hd12 and Tl12yz".to_string(),
            "https://fulluser12:Hd12\"xq Tl12".to_string(),
            // 到 `@` 为止、差一个字符。
            "https://fulluser12:Hd12\"xq Tl12y@full-only.example/simple".to_string(),
            // 同一个主机，别的用户名：别人的地址不归按值这一层管（文字规则认得出的它自己会处理）。
            "https://other12:pw@full-only.example/simple".to_string(),
        ] {
            assert_eq!(mask_known(&text), text, "{text}");
            assert!(matches!(mask_known(&text), Cow::Borrowed(_)), "{text}");
        }
        // 同样的凭据、别的主机（重定向、uv 打印的另一个地址）：凭据的完整出现，照样换掉。
        assert_eq!(
            mask_known("https://fulluser12:Hd12\"xq Tl12yz@elsewhere.example/simple"),
            "https://***@elsewhere.example/simple"
        );
        // 反过来：完整的出现嵌在别的文字里，前后的文字一个字符都不动。
        assert_eq!(
            mask_known(&format!("<<{address}>> and again {address};")),
            "<<https://***@full-only.example/simple>> and again https://***@full-only.example/simple;"
        );
    }

    #[test]
    fn masking_twice_changes_nothing_more() {
        let address = r#"https://twiceuser13:Hd13"xq Tl13yz@twice.example/x"#;
        register_address(address);
        for (_, text) in spellings(address) {
            let once = mask_userinfo(&text).into_owned();
            assert_eq!(mask_userinfo(&once), once);
        }
    }

    #[test]
    fn addresses_without_credentials_register_nothing() {
        for address in [
            "",
            "   ",
            "https://mirror.example/simple",
            "https://host/pkg@1.0",
            "https://host?email=a@b",
            "https://host#a@b",
            "file:///mnt/mirror/pypi/simple",
            "/mnt/mirror/pypi/simple",
            "host:50051",
            // 空的用户名段：没有凭据可换。
            "https://@host/x",
            // 已经是掩码。
            "https://***@host/x",
        ] {
            assert!(known_rules(address).is_empty(), "{address}");
        }
    }

    #[test]
    fn a_trimmed_and_an_untrimmed_spelling_are_both_known() {
        // Welcome 里的地址去掉了首尾空白，配置里的原样：两种都登记。
        let rules = known_rules("  https://trimuser14:pw14@trim.example/x  ");
        for text in [
            "  https://trimuser14:pw14@trim.example/x  ",
            "https://trimuser14:pw14@trim.example/x",
        ] {
            let mut masked = text.to_string();
            for rule in &rules {
                masked = masked.replace(&rule.needle, &rule.replacement);
            }
            assert!(
                !masked.contains("pw14") && !masked.contains("trimuser14"),
                "{masked}"
            );
        }
    }

    #[test]
    fn the_registry_has_a_cap_and_a_repeated_address_takes_one_slot() {
        let mut registry = Registry::default();
        let rule = |n: usize| Rule {
            needle: format!("://cap{n}:pw@"),
            replacement: "://***@".into(),
        };
        for round in 0..2 {
            for n in 0..MAX_KNOWN_ADDRESSES {
                registry.add(format!("address-{n}"), vec![rule(n)]);
            }
            assert_eq!(
                registry.entries.len(),
                MAX_KNOWN_ADDRESSES,
                "第 {round} 遍：重复的不占位"
            );
        }
        // 满了再来一个新的：丢掉最早的。
        registry.add("address-new".into(), vec![rule(1000)]);
        assert_eq!(registry.entries.len(), MAX_KNOWN_ADDRESSES);
        assert!(
            registry
                .entries
                .iter()
                .all(|(address, _)| address != "address-0")
        );
        assert_eq!(registry.entries.last().unwrap().0, "address-new");
        // 规则按 needle 的长度从长到短排。
        assert!(
            registry
                .rules
                .windows(2)
                .all(|pair| pair[0].needle.len() >= pair[1].needle.len())
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
