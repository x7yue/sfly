//! 节点包安装（docs/ARCHITECTURE.md §4.4、ADR 0002）：从控制面下载 `.sflypkg` 归档、校验 sha256，
//! 取出其中的 wheel，用 `uv pip install` 装进共享 venv（同名的其他版本被就地替换），
//! 依赖从配置的 PyPI 镜像安装；平台自己的包（标准节点包 `sfly-std`）只从控制面的包索引取（[`index_args`]），
//! 装之前先确认控制面的包索引直接回答了 `sfly-std`（[`Installer::check_package_index`]）。
//!
//! 共享 venv 里其他节点包声明的依赖（Requires-Dist）会和新 wheel 一起交给 uv 解析：
//! 新包的依赖与它们冲突时 uv 解析失败、venv 保持原样，任务以 `env_error` 失败并带上完整的 uv 输出。
//! 安装与启动新任务的互斥由调用方（`Runtime`）负责。

use std::collections::BTreeMap;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use sha2::{Digest, Sha256};

use crate::proto::AssignTask;
use crate::venv::SharedVenv;

/// 安装失败；`message` 是给任务详情看的完整说明（包含 uv 输出），`output` 是 uv 输出本身。
#[derive(Debug)]
pub struct InstallError {
    pub message: String,
    pub output: String,
}

impl InstallError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            output: String::new(),
        }
    }
}

pub struct Installer {
    pub venv: SharedVenv,
    /// 下载、解包用的临时目录的父目录。
    pub scratch: PathBuf,
    /// 生效的 PyPI 镜像：本地 `--index-url`，否则控制面在 Welcome 里下发的镜像（每次连上控制面时更新）。
    pub index_url: std::sync::Mutex<Option<String>>,
    /// 控制面的包索引（Welcome 的 `package_index_url`，每次连上控制面时更新）；旧版本控制面不下发，为 None。
    pub package_index: std::sync::Mutex<Option<String>>,
    pub uv: PathBuf,
    pub http: reqwest::Client,
}

impl Installer {
    /// 安装任务需要的节点包版本；`others` 是共享 venv 中其他节点包的依赖（包名 → Requires-Dist）。
    /// 成功时返回 uv 输出。
    pub async fn install(
        &self,
        task: &AssignTask,
        others: &BTreeMap<String, Vec<String>>,
    ) -> Result<String, InstallError> {
        let label = format!("{}@{}", task.package, task.package_version);
        if task.package_url.is_empty() {
            return Err(InstallError::new(format!(
                "节点包 {label} 没有安装在共享 venv 中，控制面也没有提供下载地址"
            )));
        }
        let archive = self.download(task, &label).await?;
        let dir = self.scratch.join(format!(
            "{}-{}-{}",
            task.package,
            task.package_version,
            std::process::id()
        ));
        let result = self
            .install_archive(&dir, archive, task, &label, others)
            .await;
        let _ = tokio::fs::remove_dir_all(&dir).await;
        result
    }

    async fn download(&self, task: &AssignTask, label: &str) -> Result<Vec<u8>, InstallError> {
        let fail = |e: String| InstallError::new(format!("下载节点包 {label} 失败：{e}"));
        let response = self
            .http
            .get(&task.package_url)
            .send()
            .await
            .map_err(|e| fail(format!("{} ({e})", task.package_url)))?;
        if !response.status().is_success() {
            return Err(fail(format!(
                "{} 返回 {}",
                task.package_url,
                response.status()
            )));
        }
        let bytes = response.bytes().await.map_err(|e| fail(e.to_string()))?;
        let actual = sha256_hex(&bytes);
        if !actual.eq_ignore_ascii_case(&task.package_sha256) {
            return Err(InstallError::new(format!(
                "节点包 {label} 的 sha256 校验失败：期望 {}，实际 {actual}",
                task.package_sha256
            )));
        }
        Ok(bytes.to_vec())
    }

    async fn install_archive(
        &self,
        dir: &Path,
        archive: Vec<u8>,
        task: &AssignTask,
        label: &str,
        others: &BTreeMap<String, Vec<String>>,
    ) -> Result<String, InstallError> {
        let _ = tokio::fs::remove_dir_all(dir).await;
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| InstallError::new(format!("创建目录 {} 失败：{e}", dir.display())))?;
        let (wheel_name, wheel) = extract_wheel(archive)
            .map_err(|e| InstallError::new(format!("节点包 {label} 的归档无效：{e}")))?;
        let wheel_path = dir.join(&wheel_name);
        tokio::fs::write(&wheel_path, wheel)
            .await
            .map_err(|e| InstallError::new(format!("写入 {} 失败：{e}", dir.display())))?;
        self.uv_install(dir, label, &task.package, &wheel_path, others, false)
            .await
    }

    /// 安装 `sfly dev` 构建的可编辑 wheel（开发版本 `包名@dev`）。即使 venv 里已经是同一个 wheel，
    /// 也强制重新安装，让重新运行 `sfly dev` 时元信息和依赖得到更新。成功时返回 uv 输出。
    pub async fn install_dev(
        &self,
        package: &str,
        wheel: &Path,
        others: &BTreeMap<String, Vec<String>>,
    ) -> Result<String, InstallError> {
        let label = format!("{package}@{}", crate::dev::DEV_VERSION);
        let dir = self
            .scratch
            .join(format!("{package}-dev-{}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&dir).await;
        let result = match tokio::fs::create_dir_all(&dir).await {
            Ok(()) => {
                self.uv_install(&dir, &label, package, wheel, others, true)
                    .await
            }
            Err(e) => Err(InstallError::new(format!(
                "创建目录 {} 失败：{e}",
                dir.display()
            ))),
        };
        let _ = tokio::fs::remove_dir_all(&dir).await;
        result
    }

    /// 用 uv 把 wheel 装进共享 venv；共享 venv 中其他节点包的依赖一起交给 uv 解析。
    async fn uv_install(
        &self,
        dir: &Path,
        label: &str,
        package: &str,
        wheel_path: &Path,
        others: &BTreeMap<String, Vec<String>>,
        reinstall: bool,
    ) -> Result<String, InstallError> {
        let mut requirements = vec![wheel_path.to_string_lossy().into_owned()];
        for (name, requires) in others {
            if !same_name(name, package) {
                requirements.extend(requires.iter().cloned());
            }
        }
        let requirements_path = dir.join("requirements.txt");
        tokio::fs::write(&requirements_path, requirements.join("\n") + "\n")
            .await
            .map_err(|e| InstallError::new(format!("写入 {} 失败：{e}", dir.display())))?;

        let pypi = self.index_url.lock().unwrap().clone();
        let package_index = self.package_index.lock().unwrap().clone();
        if let Some(index) = &package_index {
            self.check_package_index(index, label).await?;
        }
        let mut command = tokio::process::Command::new(&self.uv);
        command
            .args(["pip", "install", "--no-progress", "--color", "never"])
            .arg("--python")
            .arg(self.venv.python());
        command.args(index_args(pypi.as_deref(), package_index.as_deref()));
        if reinstall {
            command
                .args(["--reinstall-package", package])
                .args(["--refresh-package", package]);
        }
        command
            .arg("-r")
            .arg(&requirements_path)
            .env_remove("VIRTUAL_ENV")
            .stdin(Stdio::null());
        let line = format!("$ {:?}", command.as_std());
        let output = command.output().await.map_err(|e| {
            InstallError::new(format!(
                "安装节点包 {label} 失败：无法运行 uv（{}）：{e}",
                self.uv.display()
            ))
        })?;
        let mut text = format!("{line}\n");
        text.push_str(&String::from_utf8_lossy(&output.stdout));
        text.push_str(&String::from_utf8_lossy(&output.stderr));
        if output.status.success() {
            Ok(text)
        } else {
            // uv 的报错只说「你要求 sfly-std<0.4」，不说是哪个包要求的：另外写明是哪几个包、各要什么版本（#556）。
            let note = conflict_note(label, &wheel_requires(wheel_path), package, others, &text)
                .map(|note| format!("\n\n{note}"))
                .unwrap_or_default();
            Err(InstallError {
                message: format!(
                    "安装节点包 {label} 失败（uv {}）\n\n{}{note}",
                    output.status,
                    text.trim_end()
                ),
                output: text,
            })
        }
    }
}

impl Installer {
    /// 装依赖之前确认：控制面的包索引对 `sfly-std` 的项目页**直接**回答 200（不跟随重定向）**并且带标记头**
    /// [`PACKAGE_INDEX_MARKER`]（值是控制面的版本），否则不装，任务以 `env_error` 失败（#556）。
    ///
    /// 「`sfly-std` 只会来自控制面」靠的是 uv 的 `first-index`：一个名字只看第一个有回应的索引，404 才会转去下一个
    /// 索引（PyPI 镜像）。控制面自己的代码对这个名字永远有回应（还没发布时是没有版本的 200 页面），但这个地址上
    /// 回答的不一定是控制面：对外地址（`SFLY_PUBLIC_URL`）指到了别的 HTTP 服务、反向代理漏转了 `/simple/`，
    /// 404 或重定向到别处时 uv 会悄悄装上 PyPI 镜像上的同名包，安装照样成功。节点包的归档走另一个路径，
    /// 照样下载得到，别处不会先暴露问题。所以每次装依赖都先问一次（一次小请求；依赖 `sfly-std` 多半是传递依赖，
    /// 装之前看不出来，只在要求里直接写了它时才问挡不住）。
    ///
    /// 只看状态码拦不住最要紧的那种配错：对外地址指到了一个 PyPI 风格的索引（镜像），那里**有**同名包时回 200，
    /// uv 就会装上它。所以还要求控制面的标记头：别的索引服务不会带。它防的是配错，不是有意伪造（能控制这个地址的人本来
    /// 就能直接给出假包）。控制面发 `package_index_url` 的同时一定带这个头（两者在同一个 PR 里加，索引的路由总是注册），
    /// 所以不存在「有地址、没有标记」的合法组合。
    async fn check_package_index(&self, index: &str, label: &str) -> Result<(), InstallError> {
        let url = std_project_url(index);
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(INDEX_CHECK_TIMEOUT)
            .build()
            .map_err(|e| InstallError::new(format!("安装节点包 {label} 失败：{e}")))?;
        let outcome = match client.get(&url).send().await {
            Ok(response) if response.status() == reqwest::StatusCode::OK => {
                if response
                    .headers()
                    .get(PACKAGE_INDEX_MARKER)
                    .is_some_and(|value| !value.as_bytes().is_empty())
                {
                    return Ok(());
                }
                IndexAnswer::NoMarker
            }
            Ok(response) if response.status().is_redirection() => IndexAnswer::Redirect {
                status: response.status(),
                location: response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_string),
            },
            Ok(response) => IndexAnswer::Status(response.status()),
            Err(error) => IndexAnswer::Unreachable(error.to_string()),
        };
        Err(InstallError::new(index_check_failure(
            label, &url, &outcome,
        )))
    }
}

/// 控制面的包索引里 `sfly-std` 的项目页地址；`index` 是 Welcome 里的 `package_index_url`（`<对外地址>/simple/`）。
fn std_project_url(index: &str) -> String {
    format!("{}/sfly-std/", index.trim_end_matches('/'))
}

/// 控制面的包索引在每个成功的响应上带的标记头（值是控制面的版本，`apps/server/src/http/sdk-routes.ts` 的
/// `PACKAGE_INDEX_HEADER`）。
const PACKAGE_INDEX_MARKER: &str = "x-sfly-package-index";

/// 问包索引时等多久（秒）。
const INDEX_CHECK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// 控制面的包索引对 `sfly-std` 的项目页没有直接回答 200、或者回答的不是控制面。
#[derive(Debug)]
enum IndexAnswer {
    /// 回了 200，但没有控制面的标记头：这个地址上不是 sfly 控制面的包索引。
    NoMarker,
    Status(reqwest::StatusCode),
    Redirect {
        status: reqwest::StatusCode,
        location: Option<String>,
    },
    Unreachable(String),
}

/// 检查没通过时给任务详情看的说明：请求的地址、得到了什么（状态码，或重定向到了哪）、该查什么。
fn index_check_failure(label: &str, url: &str, answer: &IndexAnswer) -> String {
    let got = match answer {
        IndexAnswer::NoMarker => format!(
            "返回 200，但响应里没有 {PACKAGE_INDEX_MARKER} 头：这个地址回了 200 但不是 sfly 控制面的包索引，或者中间的反向代理去掉了这个响应头"
        ),
        IndexAnswer::Status(status) => format!("返回 {status}"),
        IndexAnswer::Redirect {
            status,
            location: Some(location),
        } => format!("返回 {status}，重定向到 {location}"),
        IndexAnswer::Redirect {
            status,
            location: None,
        } => format!("返回 {status}（重定向，没有写明去哪）"),
        IndexAnswer::Unreachable(error) => format!("请求失败：{error}"),
    };
    format!(
        "安装节点包 {label} 失败：控制面的包索引没有直接回答 sfly-std：GET {url} {got}\
         （需要直接返回 200，并带 {PACKAGE_INDEX_MARKER} 头）。\n\n\
         平台自己的包 sfly-std 只能来自控制面的包索引：这个地址回答的不是控制面时（404、重定向，或者别的索引服务回了 200），\n\
         uv 会转去 PyPI 镜像或装上别处的同名包，所以没有安装。请检查控制面的对外地址（SFLY_PUBLIC_URL）是否指向这个控制面，\n\
         反向代理有没有把 /simple/ 转发给控制面（地址、路径前缀、状态码和响应头都要对得上）。"
    )
}

/// `uv pip install` 的索引参数（#556）。节点包可以依赖平台自己的包（标准节点包 `sfly-std`，它不在 PyPI 上）：
///
/// - `--index <控制面的包索引>`：排在默认索引（PyPI 镜像）前面；
/// - `--default-index <PyPI 镜像>`：配置了镜像时用它，其余依赖（psutil 等）从这里取；
/// - `--index-strategy first-index`：同一个名字只看第一个有它的索引，所以 `sfly-std` 只来自控制面的索引，PyPI 镜像上
///   有人放了同名的更高版本也不会被装上。这是 uv 的默认策略，仍然写在命令行上：环境变量 `UV_INDEX_STRATEGY` 或
///   用户级的 uv 配置换成别的策略（例如「在所有索引里选最高版本」）时，命令行的值优先，防线不会被悄悄拆掉。
///   「有它」指索引对这个名字有回应：控制面的索引对 `sfly-std` 总有回应（还没发布时是一个没有版本的页面），不会
///   因为 404 而转去 PyPI；这个地址上回答的是不是控制面，由装之前的检查确认（[`Installer::check_package_index`]）。
///
/// 控制面没有下发包索引（旧版本控制面）时不加 `--index`：依赖只来自 PyPI 镜像，和以前一样。
fn index_args(pypi: Option<&str>, package_index: Option<&str>) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(index) = package_index {
        args.extend(["--index".to_string(), index.to_string()]);
    }
    if let Some(mirror) = pypi {
        args.extend(["--default-index".to_string(), mirror.to_string()]);
    }
    args.extend(["--index-strategy".to_string(), "first-index".to_string()]);
    args
}

/// uv 没能解析出依赖（版本要求互相矛盾）时，在 uv 的输出后面补一段：共享 venv 里一个包只能有一个版本，
/// 哪几个节点包对同一个包的版本要求不一样、各要什么。`label` 是这次要装的节点包（`名字@版本`），`requires` 是它的
/// Requires-Dist，`others` 是共享 venv 里其他节点包的依赖。没有这样的包、或者失败不是依赖解析造成的时返回 None。
///
/// 补这一段是因为 uv 只写「你要求 sfly-std<0.4」：其他已装节点包的依赖是作为一份要求清单交给 uv 的，uv 不知道
/// 它们来自哪个包。uv 提示的 `--index-strategy unsafe-best-match` 不能用（它让 PyPI 上同名的包顶替平台自己的包），
/// 输出里有这个提示时一并说明。
fn conflict_note(
    label: &str,
    requires: &[String],
    package: &str,
    others: &BTreeMap<String, Vec<String>>,
    uv_output: &str,
) -> Option<String> {
    if !uv_output.contains("No solution found") {
        return None;
    }
    let mut by_name: BTreeMap<String, Vec<(String, &str)>> = BTreeMap::new();
    for requirement in requires {
        by_name
            .entry(requirement_name(requirement))
            .or_default()
            .push((label.to_string(), requirement));
    }
    for (name, list) in others {
        if same_name(name, package) {
            continue;
        }
        for requirement in list {
            by_name
                .entry(requirement_name(requirement))
                .or_default()
                .push((format!("{name}（已安装）"), requirement));
        }
    }
    let mut lines = Vec::new();
    for (name, list) in &by_name {
        let mut distinct: Vec<&str> = list.iter().map(|(_, r)| *r).collect();
        distinct.sort_unstable();
        distinct.dedup();
        if distinct.len() < 2 {
            continue;
        }
        lines.push(format!("  {name}："));
        lines.extend(
            list.iter()
                .map(|(owner, r)| format!("    {owner} 要求 {r}")),
        );
    }
    if lines.is_empty() {
        return None;
    }
    let mut note = format!(
        "依赖冲突：共享 venv 里一个包只能有一个版本，下面这些节点包对同一个包的版本要求不一样：\n{}",
        lines.join("\n")
    );
    if uv_output.contains("unsafe-best-match") {
        note.push_str(
            "\n不要照 uv 的提示改用 --index-strategy unsafe-best-match：Agent 有意不用它，\
             让平台自己的包（sfly、sfly-std）只来自控制面的包索引，不会被 PyPI 上同名的包顶替。",
        );
    }
    Some(note)
}

/// 要求（PEP 508）里的包名，按 PEP 503 规范化：到第一个版本比较符、`[`、`;`、`@`、括号或空白为止。
fn requirement_name(requirement: &str) -> String {
    let end = requirement
        .find(|c: char| {
            matches!(c, '<' | '>' | '=' | '!' | '~' | '[' | ';' | '@' | '(') || c.is_whitespace()
        })
        .unwrap_or(requirement.len());
    requirement[..end]
        .to_ascii_lowercase()
        .replace(['_', '.'], "-")
}

/// wheel 声明的依赖（METADATA 里的 Requires-Dist，不含只在某个 extra 下才要的）；读不出来时为空。
fn wheel_requires(wheel: &Path) -> Vec<String> {
    let Ok(file) = std::fs::File::open(wheel) else {
        return Vec::new();
    };
    let Ok(mut zip) = zip::ZipArchive::new(file) else {
        return Vec::new();
    };
    let Some(name) = zip
        .file_names()
        .filter_map(Result::ok)
        .find(|n| n.ends_with(".dist-info/METADATA") && n.matches('/').count() == 1)
        .map(|n| n.into_owned())
    else {
        return Vec::new();
    };
    let mut text = String::new();
    if zip
        .by_name(&name)
        .and_then(|mut f| f.read_to_string(&mut text).map_err(Into::into))
        .is_err()
    {
        return Vec::new();
    }
    text.lines()
        .filter_map(|line| line.strip_prefix("Requires-Dist:"))
        .map(|r| r.trim().to_string())
        .filter(|r| !r.contains("extra =="))
        .collect()
}

/// 包名按 PEP 503 规范化后比较。
fn same_name(a: &str, b: &str) -> bool {
    let normalize = |s: &str| s.to_ascii_lowercase().replace(['_', '.'], "-");
    normalize(a) == normalize(b)
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// 归档根目录里唯一的 `*.whl`。
fn extract_wheel(archive: Vec<u8>) -> Result<(String, Vec<u8>), String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(archive)).map_err(|e| e.to_string())?;
    let wheels: Vec<String> = zip
        .file_names()
        .filter_map(Result::ok)
        .filter(|n| !n.contains(['/', '\\']) && n.ends_with(".whl"))
        .map(|n| n.into_owned())
        .collect();
    let [name] = wheels.as_slice() else {
        return Err(format!("根目录应恰好有一个 wheel，实际 {}", wheels.len()));
    };
    let mut file = zip.by_name(name).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    Ok((name.clone(), bytes))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::{
        IndexAnswer, conflict_note, index_args, index_check_failure, requirement_name,
        std_project_url,
    };

    fn args(pypi: Option<&str>, package_index: Option<&str>) -> Vec<String> {
        index_args(pypi, package_index)
    }

    #[test]
    fn the_control_plane_index_comes_before_the_pypi_mirror_and_the_strategy_is_always_spelled_out()
    {
        assert_eq!(
            args(Some("https://mirror/simple"), Some("http://plane/simple/")),
            [
                "--index",
                "http://plane/simple/",
                "--default-index",
                "https://mirror/simple",
                "--index-strategy",
                "first-index",
            ]
        );
    }

    #[test]
    fn without_a_package_index_only_the_pypi_mirror_is_used() {
        assert_eq!(
            args(Some("https://mirror/simple"), None),
            [
                "--default-index",
                "https://mirror/simple",
                "--index-strategy",
                "first-index"
            ]
        );
    }

    #[test]
    fn without_a_mirror_pypi_stays_the_default_index() {
        assert_eq!(
            args(None, Some("http://plane/simple/")),
            [
                "--index",
                "http://plane/simple/",
                "--index-strategy",
                "first-index"
            ]
        );
        assert_eq!(args(None, None), ["--index-strategy", "first-index"]);
    }

    #[test]
    fn requirement_names_are_normalized() {
        for (requirement, name) in [
            ("sfly-std>=0.4", "sfly-std"),
            ("Sfly_Std==0.4.0", "sfly-std"),
            ("httpx[http2]>=0.25 ; python_version >= '3.10'", "httpx"),
            ("psutil", "psutil"),
            ("pkg @ https://example.com/pkg.whl", "pkg"),
        ] {
            assert_eq!(requirement_name(requirement), name, "{requirement}");
        }
    }

    fn requires(items: &[(&str, &[&str])]) -> BTreeMap<String, Vec<String>> {
        items
            .iter()
            .map(|(name, list)| {
                (
                    name.to_string(),
                    list.iter().map(|r| r.to_string()).collect(),
                )
            })
            .collect()
    }

    const NO_SOLUTION: &str = "× No solution found when resolving dependencies:";

    #[test]
    fn the_note_names_both_packages_and_what_each_requires() {
        let others = requires(&[
            ("sfly-a", &["sfly-std<0.4", "httpx>=0.25"]),
            ("sfly-b", &["httpx>=0.25"]),
        ]);
        let note = conflict_note(
            "sfly-c@1.0.0",
            &["sfly-std>=0.4".to_string(), "httpx>=0.25".to_string()],
            "sfly-c",
            &others,
            NO_SOLUTION,
        )
        .expect("note");
        assert!(note.contains("sfly-std："), "{note}");
        assert!(note.contains("sfly-c@1.0.0 要求 sfly-std>=0.4"), "{note}");
        assert!(
            note.contains("sfly-a（已安装） 要求 sfly-std<0.4"),
            "{note}"
        );
        // 大家要求相同的包（httpx>=0.25）不是冲突，不写。
        assert!(!note.contains("httpx"), "{note}");
        assert!(!note.contains("unsafe-best-match"), "{note}");
    }

    #[test]
    fn the_note_is_only_for_resolution_failures_with_a_real_difference() {
        let others = requires(&[("sfly-a", &["sfly-std<0.4"])]);
        let new = ["sfly-std>=0.4".to_string()];
        // 失败不是依赖解析造成的（例如下载失败）。
        assert_eq!(
            conflict_note(
                "sfly-c@1",
                &new,
                "sfly-c",
                &others,
                "error: failed to download"
            ),
            None
        );
        // 要求一样，没有可写的。
        assert_eq!(
            conflict_note(
                "sfly-c@1",
                &["sfly-std<0.4".to_string()],
                "sfly-c",
                &others,
                NO_SOLUTION
            ),
            None
        );
        // 这个包自己的旧版本的依赖不算：它就要被换掉。
        assert_eq!(
            conflict_note(
                "sfly-a@2",
                &["sfly-std>=0.4".to_string()],
                "sfly-a",
                &others,
                NO_SOLUTION
            ),
            None
        );
    }

    #[test]
    fn the_note_warns_against_the_unsafe_best_match_hint_that_uv_prints() {
        let others = requires(&[("sfly-a", &["sfly-std<0.4"])]);
        let output = format!("{NO_SOLUTION}\nhint: use `--index-strategy unsafe-best-match`");
        let note = conflict_note(
            "sfly-c@1",
            &["sfly-std>=0.4".to_string()],
            "sfly-c",
            &others,
            &output,
        )
        .expect("note");
        assert!(note.contains("不要照 uv 的提示"), "{note}");
    }

    #[test]
    fn the_std_project_page_is_under_the_package_index() {
        assert_eq!(
            std_project_url("http://plane:8080/prefix/simple/"),
            "http://plane:8080/prefix/simple/sfly-std/"
        );
        // 没有末尾的 `/` 也一样。
        assert_eq!(
            std_project_url("http://plane/simple"),
            "http://plane/simple/sfly-std/"
        );
    }

    #[test]
    fn the_failure_names_the_address_what_came_back_and_what_to_check() {
        let url = "http://plane/simple/sfly-std/";
        let not_found = index_check_failure(
            "sfly-demo@1.0.0",
            url,
            &IndexAnswer::Status(reqwest::StatusCode::NOT_FOUND),
        );
        assert!(not_found.contains("sfly-demo@1.0.0"), "{not_found}");
        assert!(
            not_found.contains("GET http://plane/simple/sfly-std/ 返回 404 Not Found"),
            "{not_found}"
        );
        assert!(
            not_found.contains("SFLY_PUBLIC_URL") && not_found.contains("/simple/"),
            "{not_found}"
        );

        let moved = index_check_failure(
            "sfly-demo@1.0.0",
            url,
            &IndexAnswer::Redirect {
                status: reqwest::StatusCode::FOUND,
                location: Some("https://pypi.example/simple/sfly-std/".into()),
            },
        );
        assert!(
            moved.contains("返回 302 Found，重定向到 https://pypi.example/simple/sfly-std/"),
            "{moved}"
        );

        let imposter = index_check_failure("sfly-demo@1.0.0", url, &IndexAnswer::NoMarker);
        assert!(
            imposter.contains(
                "GET http://plane/simple/sfly-std/ 返回 200，但响应里没有 x-sfly-package-index 头"
            ),
            "{imposter}"
        );
        assert!(
            imposter.contains("这个地址回了 200 但不是 sfly 控制面的包索引"),
            "{imposter}"
        );
        // 反向代理去掉了响应头时回答的其实是控制面：第一句也要把这种可能写上。
        assert!(
            imposter.contains("或者中间的反向代理去掉了这个响应头"),
            "{imposter}"
        );
        assert!(imposter.contains("SFLY_PUBLIC_URL"), "{imposter}");

        let down = index_check_failure(
            "sfly-demo@1.0.0",
            url,
            &IndexAnswer::Unreachable("connection refused".into()),
        );
        assert!(down.contains("请求失败：connection refused"), "{down}");
    }
}
