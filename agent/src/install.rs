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
use std::str::FromStr as _;

use pep440_rs::{Version, VersionSpecifiers};
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
            let note = conflict_note(
                label,
                &wheel_requires(wheel_path),
                package,
                wheel_version(wheel_path).as_deref(),
                others,
                &text,
            )
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

/// uv 解析不出依赖时输出里的这一句。
const UV_NO_SOLUTION: &str = "No solution found";

/// 补的说明最多列这么多对（节点包，要求）：已安装的节点包很多时说明能到几十 KB，再多的只写个数。
const NOTE_LIMIT: usize = 20;

/// uv 没能解析出依赖（版本要求互相矛盾）时，在 uv 的输出后面补一段：共享 venv 里一个包只能有一个版本，
/// 哪几个节点包对同一个包的版本要求不一样、各要什么。`label` 是这次要装的节点包（`名字@版本`），`requires` 是它的
/// Requires-Dist，`version` 是它自己的版本，`others` 是共享 venv 里其他节点包的依赖。没有这样的包、或者失败不是
/// 依赖解析造成的时返回 None。
///
/// 补这一段是因为 uv 只写「你要求 sfly-std<0.4」：其他已装节点包的依赖是作为一份要求清单交给 uv 的，uv 不知道
/// 它们来自哪个包。正在装的这个包本身也是清单里的一条要求（wheel 文件把它钉在这一个版本上，写成 `名字==版本`）：
/// 别的已装节点包要求它的另一个版本时（典型的是标准节点包 `sfly-std` 的 0.3.0 和依赖 `sfly-std>=0.4` 的节点包），
/// 冲突的就是这条，要写出来，不然这一包只剩一条要求、说明不出现（#637、#653）。
///
/// 什么时候把正在装的版本也算一条，不看 uv 的文字（交给 uv 的命令行里就有这个包的名字，它自己的依赖卷进失败时 uv
/// 也会写到它，文字分不开这些情况）：按 PEP 440 算，别的已装节点包对它的要求里，正在装的版本**不满足**的才列，
/// 和它自己的那一条配成一对；都满足时不列这一包，失败是别的原因造成的。要求的写法只认「包名、可选的方括号、版本限制」
/// （`version_requirement`），带环境标记的、URL 形式的、没有版本限制的、拆不出来的都当作不适用，不列。整段说明里一对都没有时
/// 返回 None，不写「怎么办」。
///
/// uv 提示的 `--index-strategy unsafe-best-match` 不能用（它让 PyPI 上同名的包顶替平台自己的包），
/// 输出里有这个提示时一并说明。
fn conflict_note(
    label: &str,
    requires: &[String],
    package: &str,
    version: Option<&str>,
    others: &BTreeMap<String, Vec<String>>,
    uv_output: &str,
) -> Option<String> {
    if !uv_output.contains(UV_NO_SOLUTION) {
        return None;
    }
    // 正在装的包的名字和版本：它的要求和钉住自己的那一条都写成「<label>（正在装）」。
    let installing = format!("{label}（正在装）");
    let own_name = requirement_name(package);
    // 每一组是一个包和要求它的各方；正在装的包自己的那一组放在最前面，它是最常见的原因，也不会被下面的上限截掉。
    let mut groups: Vec<(String, Vec<(String, String)>)> = Vec::new();
    if let Some(version) = version {
        let blockers = blockers(package, version, others);
        if !blockers.is_empty() {
            let mut list = vec![(installing.clone(), format!("{package}=={version}"))];
            list.extend(blockers);
            groups.push((own_name.clone(), list));
        }
    }
    let mut by_name: BTreeMap<String, Vec<(String, &str)>> = BTreeMap::new();
    for requirement in requires {
        by_name
            .entry(requirement_name(requirement))
            .or_default()
            .push((installing.clone(), requirement));
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
    for (name, list) in by_name {
        // 对正在装的包自己的要求上面已经按版本判断过了。
        if name == own_name {
            continue;
        }
        let mut distinct: Vec<&str> = list.iter().map(|(_, r)| *r).collect();
        distinct.sort_unstable();
        distinct.dedup();
        if distinct.len() < 2 {
            continue;
        }
        groups.push((
            name,
            list.into_iter().map(|(o, r)| (o, r.to_string())).collect(),
        ));
    }
    if groups.is_empty() {
        return None;
    }
    let total: usize = groups.iter().map(|(_, list)| list.len()).sum();
    let mut lines = Vec::new();
    let mut shown = 0;
    for (name, list) in &groups {
        if shown >= NOTE_LIMIT {
            break;
        }
        let take = list.len().min(NOTE_LIMIT - shown);
        lines.push(format!("  {name}："));
        lines.extend(
            list[..take]
                .iter()
                .map(|(owner, r)| format!("    {owner} 要求 {r}")),
        );
        shown += take;
    }
    if total > shown {
        lines.push(format!("  另有 {} 对没有列出", total - shown));
    }
    let mut note = format!(
        "依赖冲突：共享 venv 里一个包只能有一个版本，下面这些节点包对同一个包的版本要求不一样：\n{}\n\
         怎么办：让这些节点包要求的版本一致（把它们和锁定了它们的场景一起升级），\
         或者把互相冲突的节点包分到不同的 Agent 上：一台 Agent 上所有节点包共用一个环境",
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

/// 别的已装节点包对 `package` 的要求里，正在装的 `version` 不满足的（按 PEP 440，本地版本标签照规矩忽略），
/// 每条是（`名字（已安装）`，要求原文）。只认能拆出「包名、版本限制」的要求（`version_requirement`），判断不了的不列。
fn blockers(
    package: &str,
    version: &str,
    others: &BTreeMap<String, Vec<String>>,
) -> Vec<(String, String)> {
    let Ok(version) = Version::from_str(version) else {
        return Vec::new();
    };
    let wanted = canonical_name(package);
    let mut found = Vec::new();
    for (name, list) in others {
        if same_name(name, package) {
            continue;
        }
        for text in list {
            let Some((required, specifiers)) = version_requirement(text) else {
                continue;
            };
            if required == wanted && !specifiers.contains(&version) {
                found.push((format!("{name}（已安装）"), text.clone()));
            }
        }
    }
    found
}

/// 包名按 PEP 503 规范化：小写，连续的 `-`、`_`、`.` 合成一个 `-`。
fn canonical_name(name: &str) -> String {
    let mut canonical = String::with_capacity(name.len());
    let mut separator = false;
    for c in name.chars() {
        if matches!(c, '-' | '_' | '.') {
            separator = true;
            continue;
        }
        if separator && !canonical.is_empty() {
            canonical.push('-');
        }
        separator = false;
        canonical.push(c.to_ascii_lowercase());
    }
    canonical
}

/// 一条要求（PEP 508）里的包名（规范化之后）和版本限制：`名字`、可选的 `[extras]`、版本限制（可以写在括号里，
/// 多个限制用逗号隔开）。带环境标记的（`; python_version < "3.12"`）、URL 形式的（`名字 @ 地址`）、没有版本限制的、
/// 拆不出来的、限制读不懂的、限制里有 `===` 或 `!=…*` 的（见下面）返回 None：这些判断不了，当作不适用。带标记和 URL 的写法在名字后面跟的不是版本限制，
/// 下面读版本限制时读不懂，自然是 None。
fn version_requirement(text: &str) -> Option<(String, VersionSpecifiers)> {
    let text = text.trim();
    let name_end = text
        .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')))
        .unwrap_or(text.len());
    let name = &text[..name_end];
    if !name.starts_with(|c: char| c.is_ascii_alphanumeric()) {
        return None;
    }
    let mut rest = text[name_end..].trim_start();
    if let Some(after) = rest.strip_prefix('[') {
        rest = after.split_once(']')?.1.trim_start();
    }
    let specifiers = match rest.strip_prefix('(') {
        Some(inner) => inner.strip_suffix(')')?.trim(),
        None => rest,
    };
    if specifiers.is_empty() {
        return None;
    }
    // `===`（任意相等）和 `!=X.*`（通配的不等）：pep440_rs 的判断和 uv 的不一样（`===` 它按字符串比，uv 按版本比；
    // `!=X.*` 的前缀比版本的段数多时它只比到较短的那一段），会列出 uv 并不认为冲突的一对。判断不一致时宁可不列，
    // 当作不适用。`==X.*` 方向相反，只会少列，不动。
    if specifiers
        .split(',')
        .map(str::trim)
        .any(|limit| limit.starts_with("===") || (limit.starts_with("!=") && limit.contains('*')))
    {
        return None;
    }
    Some((
        canonical_name(name),
        VersionSpecifiers::from_str(specifiers).ok()?,
    ))
}

/// 要求（PEP 508）里的包名，按 PEP 503 规范化：到第一个版本比较符、`[`、`;`、`@`、括号或空白为止。
fn requirement_name(requirement: &str) -> String {
    let end = requirement
        .find(|c: char| {
            matches!(c, '<' | '>' | '=' | '!' | '~' | '[' | ';' | '@' | '(') || c.is_whitespace()
        })
        .unwrap_or(requirement.len());
    canonical_name(&requirement[..end])
}

/// wheel 文件名里的包名和版本（`{包名}-{版本}-{python}-{abi}-{平台}.whl`，包名和版本里的 `-` 已经写成 `_`）。
fn wheel_name_and_version(wheel: &Path) -> Option<(String, String)> {
    let file = wheel.file_name()?.to_str()?;
    let mut parts = file.strip_suffix(".whl")?.split('-');
    Some((parts.next()?.to_string(), parts.next()?.to_string()))
}

/// wheel 的 METADATA 文本：取和 wheel 文件名对得上的那一份 `<包名>-<版本>.dist-info/METADATA`（uv 也是读这一份），
/// wheel 里放着别的包的 dist-info 时不会读错；读不出来时为 None。
fn wheel_metadata(wheel: &Path) -> Option<String> {
    let (package, version) = wheel_name_and_version(wheel)?;
    let normalize = |name: &str| name.to_ascii_lowercase().replace(['-', '.'], "_");
    let file = std::fs::File::open(wheel).ok()?;
    let mut zip = zip::ZipArchive::new(file).ok()?;
    let name = zip
        .file_names()
        .filter_map(Result::ok)
        .find(|n| {
            let Some(dir) = n
                .strip_suffix("/METADATA")
                .and_then(|d| d.strip_suffix(".dist-info"))
            else {
                return false;
            };
            dir.split_once('-').is_some_and(|(p, v)| {
                !p.contains('/')
                    && normalize(p) == normalize(&package)
                    && v.eq_ignore_ascii_case(&version)
            })
        })
        .map(|n| n.into_owned())?;
    let mut text = String::new();
    zip.by_name(&name)
        .and_then(|mut f| f.read_to_string(&mut text).map_err(Into::into))
        .ok()?;
    Some(text)
}

/// METADATA 的头部（到第一个空行为止；空行后面是长描述，里面写着什么都不是元数据）里的 `名字: 值`，
/// 名字不分大小写；续行（以空白开头）不是新的头。
fn metadata_headers(text: &str) -> impl Iterator<Item = (&str, &str)> {
    text.lines()
        .take_while(|line| !line.trim().is_empty())
        .filter(|line| !line.starts_with([' ', '\t']))
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim(), value.trim()))
}

/// wheel 声明的依赖（METADATA 头部里的 Requires-Dist，不含只在某个 extra 下才要的）；读不出来时为空。
fn wheel_requires(wheel: &Path) -> Vec<String> {
    wheel_metadata(wheel)
        .map(|text| {
            metadata_headers(&text)
                .filter(|(name, _)| name.eq_ignore_ascii_case("Requires-Dist"))
                .map(|(_, value)| value.to_string())
                .filter(|r| !r.contains("extra =="))
                .collect()
        })
        .unwrap_or_default()
}

/// wheel 自己的版本（METADATA 头部里的 Version）；读不出来或者是空的时为 None。
fn wheel_version(wheel: &Path) -> Option<String> {
    let text = wheel_metadata(wheel)?;
    metadata_headers(&text)
        .find(|(name, _)| name.eq_ignore_ascii_case("Version"))
        .map(|(_, value)| value.to_string())
        .filter(|value| !value.is_empty())
}

/// 包名按 PEP 503 规范化后比较。
fn same_name(a: &str, b: &str) -> bool {
    canonical_name(a) == canonical_name(b)
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

    use std::path::PathBuf;

    use super::{
        IndexAnswer, canonical_name, conflict_note, index_args, index_check_failure,
        requirement_name, std_project_url, version_requirement, wheel_requires, wheel_version,
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
            // 连续的分隔符合成一个。
            ("sfly__base>=2", "sfly-base"),
            ("Sfly_-.Base>=2", "sfly-base"),
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

    /// 真实路径上交给 `conflict_note` 的输出：第一行是 Agent 自己写的命令行，里面带着正在装的包的名字
    /// （`requirements.txt` 的目录名是「包名-版本-进程号」，开发版本还有 `--reinstall-package 包名`）。
    fn uv_output(package: &str, version: &str, words: &str) -> String {
        format!(
            "$ env -u VIRTUAL_ENV \"uv\" \"pip\" \"install\" \"--no-progress\" \"--python\" \"venv/bin/python\" \
             \"-r\" \"scratch/{package}-{version}-4242/requirements.txt\"\n{NO_SOLUTION}\n{words}\n"
        )
    }

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
            None,
            &others,
            NO_SOLUTION,
        )
        .expect("note");
        assert!(note.contains("sfly-std："), "{note}");
        assert!(
            note.contains("sfly-c@1.0.0（正在装） 要求 sfly-std>=0.4"),
            "{note}"
        );
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
                None,
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
                None,
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
                None,
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
            None,
            &others,
            &output,
        )
        .expect("note");
        assert!(note.contains("不要照 uv 的提示"), "{note}");
    }

    #[test]
    fn the_package_being_installed_counts_as_a_requirement_on_itself_when_it_is_excluded() {
        // 锁定 sfly-std 0.3.0 的场景要装 0.3.0，共享环境里另一个节点包依赖 sfly-std>=0.4：冲突的就是
        // 「正在装的这一版」和那个节点包的要求，不写出来的话 sfly-std 只剩一条要求，用户看不出是谁要的（#637、#653）。
        let others = requires(&[("sfly-user", &["sfly-std>=0.4", "httpx>=0.25"])]);
        let output = uv_output(
            "sfly-std",
            "0.3.0",
            "  ╰─▶ Because only sfly-std<0.4 is available and you require sfly-std>=0.4, \
             we can conclude that your requirements are unsatisfiable.",
        );

        let note = conflict_note(
            "sfly-std@0.3.0",
            &["httpx>=0.25".to_string()],
            "sfly-std",
            Some("0.3.0"),
            &others,
            &output,
        )
        .expect("note");

        assert!(note.contains("sfly-std："), "{note}");
        assert!(
            note.contains("sfly-std@0.3.0（正在装） 要求 sfly-std==0.3.0"),
            "{note}"
        );
        assert!(
            note.contains("sfly-user（已安装） 要求 sfly-std>=0.4"),
            "{note}"
        );
        assert!(note.contains("怎么办"), "{note}");
        // 要求相同的包（httpx>=0.25）不是冲突，不写。
        assert!(!note.contains("httpx"), "{note}");
    }

    #[test]
    fn a_version_that_satisfies_every_requirement_on_it_is_not_paired_whatever_the_output_says() {
        // 另一个节点包要求 sfly-std>=0.4、正在装的恰好是 0.4.0：它们不冲突。失败是别的原因造成的：不写。
        // 交给说明的输出第一行是命令行，里面总有这个包的名字；uv 的原话里也可以写到它（它自己的依赖卷进失败时），
        // 所以判断不看输出的文字。
        let others = requires(&[("sfly-user", &["sfly-std>=0.4"])]);
        for words in [
            "  ╰─▶ Because httpx>=0.30 is unavailable ...",
            "  ╰─▶ Because sfly-missing was not found in the package registry and sfly-std==0.4.0 \
             depends on sfly-missing>=1, we can conclude that you require sfly-std>=0.4 is unsatisfiable.",
        ] {
            let output = uv_output("sfly-std", "0.4.0", words);

            assert_eq!(
                conflict_note(
                    "sfly-std@0.4.0",
                    &[],
                    "sfly-std",
                    Some("0.4.0"),
                    &others,
                    &output
                ),
                None,
                "{output}"
            );
        }
    }

    #[test]
    fn only_the_requirements_that_exclude_the_version_are_listed() {
        // 被 >=2、>=3 挡住，>=0.5 不挡：不列。
        let others = requires(&[
            ("sfly-u1", &["sfly-base>=2"]),
            ("sfly-u2", &["sfly-base>=3"]),
            ("sfly-u3", &["sfly-base>=0.5"]),
            ("sfly-u4", &["sfly-base"]),
            ("sfly-u5", &["sfly-base!=1.0.1"]),
        ]);
        let output = uv_output("sfly-base", "1.0.0", "");

        let note = conflict_note(
            "sfly-base@1.0.0",
            &[],
            "sfly-base",
            Some("1.0.0"),
            &others,
            &output,
        )
        .expect("note");

        assert!(
            note.contains("sfly-base@1.0.0（正在装） 要求 sfly-base==1.0.0"),
            "{note}"
        );
        assert!(
            note.contains("sfly-u1（已安装） 要求 sfly-base>=2"),
            "{note}"
        );
        assert!(
            note.contains("sfly-u2（已安装） 要求 sfly-base>=3"),
            "{note}"
        );
        for fine in ["sfly-u3", "sfly-u4", "sfly-u5"] {
            assert!(!note.contains(fine), "{note}");
        }
    }

    #[test]
    fn the_package_name_is_compared_after_normalization() {
        // 要装的包的名字不一定是规范化之后的写法，别的节点包的要求里写的可能是另一种写法：照样认得出是同一个包。
        let others = requires(&[
            ("sfly-user", &["sfly-base>=2"]),
            ("sfly-other", &["SFLY.base<0.5"]),
        ]);

        let note = conflict_note(
            "Sfly_Base@1.0.0",
            &[],
            "Sfly_Base",
            Some("1.0.0"),
            &others,
            &uv_output("Sfly_Base", "1.0.0", ""),
        )
        .expect("note");

        assert!(note.contains("sfly-base："), "{note}");
        assert!(
            note.contains("sfly-user（已安装） 要求 sfly-base>=2"),
            "{note}"
        );
        assert!(
            note.contains("sfly-other（已安装） 要求 SFLY.base<0.5"),
            "{note}"
        );
    }

    #[test]
    fn requirements_that_uv_judges_differently_from_the_library_are_not_listed() {
        // 用真 uv 对照过：正在装的版本 × 别的节点包的要求，pep440_rs 说不满足、uv 却解得出来的就这两类，
        // 共 7 种：`===`（库按字符串比，uv 按版本比）、`!=X.*` 的前缀比版本的段数多（库只比到较短的那一段）。
        // 判断不一致时宁可不列。
        for (version, requirement) in [
            ("1.0.0", "sfly-base===1.0"),
            ("1.0", "sfly-base===1.0.0"),
            ("1.0.0+dev", "sfly-base===1.0.0"),
            ("1", "sfly-base!=1.1.*"),
            ("1.0", "sfly-base!=1.0.0.1.*"),
            ("1.0.0", "sfly-base!=1.0.0.1.*"),
            ("1.0", "sfly-base!=1.0.1.*"),
            ("0.4", "sfly-base!=0.4.1.*"),
            // 同类的别的写法：照样不判断。
            ("2.0", "sfly-base===1.0"),
            ("1.1", "sfly-base!=1.1.*"),
        ] {
            let others = requires(&[("sfly-user", &[requirement])]);
            assert_eq!(
                conflict_note(
                    &format!("sfly-base@{version}"),
                    &[],
                    "sfly-base",
                    Some(version),
                    &others,
                    &uv_output("sfly-base", version, "")
                ),
                None,
                "{version} {requirement}"
            );
        }
        // 方向相反、只会少列的 `==X.*` 不在其中，照常判断；`!=` 不带通配也照常判断。
        for (version, requirement) in [("1.5.0", "sfly-base==1.4.*"), ("1.4.1", "sfly-base!=1.4.1")]
        {
            let others = requires(&[("sfly-user", &[requirement])]);
            assert!(
                conflict_note(
                    &format!("sfly-base@{version}"),
                    &[],
                    "sfly-base",
                    Some(version),
                    &others,
                    &uv_output("sfly-base", version, "")
                )
                .is_some(),
                "{version} {requirement}"
            );
        }
    }

    #[test]
    fn a_requirement_with_doubled_separators_is_a_requirement_on_the_package_itself() {
        // 别的节点包把对正在装的包的要求写成 `sfly__base`（连续的分隔符）：照样认得出是同一个包。5.0.0 都满足，
        // 没有凑出来的一对，也不会落回「写法不一样就列」的规则、列出两条其实都满足的要求。失败是 sfly-dep 的矛盾。
        let others = requires(&[
            ("sfly-a", &["sfly-dep>=2"]),
            ("sfly-b", &["sfly-dep<2"]),
            ("sfly-u1", &["sfly__base>=2"]),
            ("sfly-u2", &["sfly__base>=3"]),
        ]);

        let note = conflict_note(
            "sfly-base@5.0.0",
            &[],
            "sfly-base",
            Some("5.0.0"),
            &others,
            &uv_output(
                "sfly-base",
                "5.0.0",
                "  ╰─▶ Because you require sfly-dep>=2 and sfly-dep<2, we can conclude that your requirements are unsatisfiable.",
            ),
        )
        .expect("note");

        assert!(note.contains("sfly-a（已安装） 要求 sfly-dep>=2"), "{note}");
        assert!(
            !note.contains("sfly-u1") && !note.contains("sfly-u2"),
            "{note}"
        );
        assert!(
            !note.contains("sfly-base") && !note.contains("sfly--base"),
            "{note}"
        );
        // 它们真的挡路时（要求的版本比正在装的高）照常列出，写成什么样的名字都一样。
        let note = conflict_note(
            "sfly-base@1.0.0",
            &[],
            "sfly-base",
            Some("1.0.0"),
            &others,
            &uv_output("sfly-base", "1.0.0", ""),
        )
        .expect("note");
        assert!(
            note.contains("sfly-u1（已安装） 要求 sfly__base>=2"),
            "{note}"
        );
        assert!(
            note.contains("sfly-u2（已安装） 要求 sfly__base>=3"),
            "{note}"
        );
        assert_eq!(note.matches("sfly-base：").count(), 1, "{note}");
    }

    #[test]
    fn requirements_on_other_packages_and_the_replaced_copy_do_not_count() {
        // 别的包的要求（httpx>=2）和这个版本无关；已装的同名包自己（它就要被换掉）的要求也不算，不管它登记的名字
        // 是哪种写法。
        let others = requires(&[
            ("sfly-user", &["httpx>=2", "sfly-base-extra>=2"]),
            ("sfly-base", &["sfly-base>=2"]),
            ("Sfly__Base", &["sfly-base>=2"]),
        ]);
        assert_eq!(
            conflict_note(
                "sfly-base@1.0.0",
                &[],
                "sfly-base",
                Some("1.0.0"),
                &others,
                &uv_output("sfly-base", "1.0.0", "")
            ),
            None
        );
    }

    #[test]
    fn versions_are_compared_by_pep_440_not_by_text() {
        let blocked = |version: &str, requirement: &str| {
            let others = requires(&[("sfly-user", &[requirement])]);
            conflict_note(
                &format!("sfly-base@{version}"),
                &[],
                "sfly-base",
                Some(version),
                &others,
                &uv_output("sfly-base", version, ""),
            )
            .is_some()
        };
        // 数值比较，不是字符串比较：1.10 比 1.9 大。
        assert!(!blocked("1.10.0", "sfly-base>=1.9"));
        assert!(blocked("1.9.0", "sfly-base>=1.10"));
        // 末尾补零相等。
        assert!(!blocked("1.0", "sfly-base==1.0.0"));
        // 预发布版本小于它的正式版。
        assert!(blocked("0.4.0rc1", "sfly-base>=0.4"));
        // 开发版本（`+dev` 是本地版本标签）：照 PEP 440，要求里没有本地标签时标签忽略不计。
        assert!(!blocked("1.0.0+dev", "sfly-base==1.0.0"));
        assert!(!blocked("1.0.0+dev", "sfly-base>=1.0.0"));
        assert!(blocked("1.0.0+dev", "sfly-base>=2"));
        // 兼容版本、通配、多个限制。
        assert!(!blocked("1.4.2", "sfly-base~=1.4"));
        assert!(blocked("2.0.0", "sfly-base~=1.4"));
        assert!(!blocked("1.4.2", "sfly-base==1.4.*"));
        assert!(blocked("1.5.0", "sfly-base==1.4.*"));
        assert!(blocked("1.0.0", "sfly-base>=1.0,<1.0"));
        // 括号和空白的写法、包名的另一种写法。
        assert!(blocked("1.0.0", "Sfly_Base (>=2)"));
    }

    #[test]
    fn requirements_that_cannot_be_judged_are_not_listed() {
        let others = requires(&[
            (
                "url-user",
                &["sfly-base @ https://example.com/sfly_base-9.0-py3-none-any.whl"],
            ),
            ("garbage-user", &["this is not a requirement"]),
            ("sfly-c", &["sfly-base>=2"]),
        ]);
        let note = conflict_note(
            "sfly-base@1.0.0",
            &[],
            "sfly-base",
            Some("1.0.0"),
            &others,
            &uv_output("sfly-base", "1.0.0", ""),
        )
        .expect("note");
        assert!(
            note.contains("sfly-c（已安装） 要求 sfly-base>=2"),
            "{note}"
        );
        assert!(
            !note.contains("url-user") && !note.contains("garbage-user"),
            "{note}"
        );
        // 正在装的版本自己读不懂：没有可判断的。
        assert_eq!(
            conflict_note(
                "sfly-base@x",
                &[],
                "sfly-base",
                Some("not a version"),
                &others,
                &uv_output("sfly-base", "x", "")
            ),
            None
        );
    }

    #[test]
    fn requirements_with_a_marker_are_not_listed_even_when_they_would_apply() {
        // 环境标记不判断（不去问解释器）：带标记的要求当作不适用，不列。
        let others = requires(&[
            ("sfly-plain", &["sfly-base>=2"]),
            ("sfly-new", &["sfly-base>=2 ; python_version >= '3.9'"]),
            ("sfly-old", &["sfly-base>=2 ; python_version < '3.9'"]),
            ("sfly-extra", &["sfly-base>=2 ; extra == 'dev'"]),
            ("sfly-nospace", &["sfly-base>=2;sys_platform=='linux'"]),
        ]);
        let note = conflict_note(
            "sfly-base@1.0.0",
            &[],
            "sfly-base",
            Some("1.0.0"),
            &others,
            &uv_output("sfly-base", "1.0.0", ""),
        )
        .expect("note");
        assert!(note.contains("sfly-plain（已安装）"), "{note}");
        for not_listed in ["sfly-new", "sfly-old", "sfly-extra", "sfly-nospace"] {
            assert!(!note.contains(not_listed), "{note}");
        }
        // 只有带标记的要求时没有可列的：不写说明。
        let only_marked = requires(&[("sfly-new", &["sfly-base>=2 ; python_version >= '3.9'"])]);
        assert_eq!(
            conflict_note(
                "sfly-base@1.0.0",
                &[],
                "sfly-base",
                Some("1.0.0"),
                &only_marked,
                &uv_output("sfly-base", "1.0.0", "")
            ),
            None
        );
    }

    #[test]
    fn a_requirement_line_is_split_into_the_name_and_the_version_limits() {
        let specifiers = |text: &str| version_requirement(text).map(|(n, s)| (n, s.to_string()));
        let some = |name: &str, spec: &str| Some((name.to_string(), spec.to_string()));
        // 名字规范化：大小写、`-` `_` `.`、连续的分隔符。
        assert_eq!(specifiers("sfly-base>=2"), some("sfly-base", ">=2"));
        assert_eq!(specifiers("Sfly_Base>=2"), some("sfly-base", ">=2"));
        assert_eq!(specifiers("sfly.base==1.0"), some("sfly-base", "==1.0"));
        assert_eq!(specifiers("Sfly__-.Base>=2"), some("sfly-base", ">=2"));
        // 空白和括号。
        assert_eq!(specifiers("  sfly-base  >= 2  "), some("sfly-base", ">=2"));
        assert_eq!(specifiers("sfly-base (>=2)"), some("sfly-base", ">=2"));
        assert_eq!(specifiers("sfly-base(>=2)"), some("sfly-base", ">=2"));
        assert_eq!(specifiers("sfly-base ( >=2 )"), some("sfly-base", ">=2"));
        // 方括号（extras）。
        assert_eq!(specifiers("httpx[http2]>=0.25"), some("httpx", ">=0.25"));
        assert_eq!(
            specifiers("httpx [http2, brotli] (>=0.25)"),
            some("httpx", ">=0.25")
        );
        // 多个限制用逗号隔开（读出来的次序不要紧：只用来判断满不满足）。
        let (_, many) = version_requirement("sfly-base>=1.0, <2").expect("split");
        assert!(many.contains(&"1.5".parse().unwrap()));
        assert!(!many.contains(&"2.0".parse().unwrap()));
        assert!(!many.contains(&"0.9".parse().unwrap()));
        // 各种运算符。
        for spec in [
            "~=1.4",
            "==1.4.*",
            "!=1.4.1",
            "<=2",
            "<2",
            ">1",
            ">=1,!=1.4.1",
        ] {
            assert!(
                version_requirement(&format!("sfly-base{spec}")).is_some(),
                "{spec}"
            );
        }
        // 当作不适用的：带环境标记、URL、没有版本限制、拆不出来、限制读不懂。
        for text in [
            "sfly-base>=2 ; python_version < '3.9'",
            "sfly-base>=2;sys_platform=='linux'",
            "sfly-base @ https://example.com/sfly_base-1.0-py3-none-any.whl",
            "sfly-base@https://example.com/sfly_base-1.0-py3-none-any.whl",
            "sfly-base",
            "sfly-base[extra]",
            "sfly-base ()",
            "",
            "   ",
            ">=2",
            "-sfly-base>=2",
            "this is not a requirement",
            "sfly-base>=",
            "sfly-base>=not.a.version",
            // uv 和库判断不一样的两种写法：`===`、`!=X.*`（任何一个限制是就算）。
            "sfly-base===1.0",
            "sfly-base === 1.0",
            "sfly-base (===1.0)",
            "sfly-base>=1,===1.2",
            "sfly-base!=1.0.1.*",
            "sfly-base != 1.0.*",
            "sfly-base>=1,!=1.5.*",
            "sfly-base[extra>=2",
            "sfly-base (>=2",
        ] {
            assert_eq!(specifiers(text), None, "{text:?}");
        }
    }

    #[test]
    fn package_names_are_compared_after_pep_503_normalization() {
        for (name, canonical) in [
            ("sfly-base", "sfly-base"),
            ("Sfly_Base", "sfly-base"),
            ("SFLY.BASE", "sfly-base"),
            ("sfly--base", "sfly-base"),
            ("sfly_-.base", "sfly-base"),
            ("Friendly-Bard", "friendly-bard"),
        ] {
            assert_eq!(canonical_name(name), canonical, "{name}");
        }
    }

    #[test]
    fn the_own_version_is_only_added_when_it_is_known() {
        // 读不到版本时，不写这一条。
        let others = requires(&[("sfly-user", &["sfly-std>=0.4"])]);
        let output = uv_output(
            "sfly-std",
            "dev",
            "  ╰─▶ Because only sfly-std<0.4 is available",
        );

        assert_eq!(
            conflict_note("sfly-std@dev", &[], "sfly-std", None, &others, &output),
            None
        );
    }

    #[test]
    fn a_development_version_is_listed_with_the_version_in_its_metadata() {
        // `sfly dev` 构建的可编辑 wheel 的 METADATA 写的是带 `+dev` 的版本：读得到，照常写出来。
        let others = requires(&[("sfly-user", &["sfly-base>=2"])]);
        let note = conflict_note(
            "sfly-base@dev",
            &[],
            "sfly-base",
            Some("1.0.0+dev"),
            &others,
            &uv_output("sfly-base", "dev", ""),
        )
        .expect("note");
        assert!(
            note.contains("sfly-base@dev（正在装） 要求 sfly-base==1.0.0+dev"),
            "{note}"
        );
    }

    #[test]
    fn the_package_being_installed_comes_first_and_is_not_cut_by_the_limit() {
        // 别的包的冲突（这里 25 个包各有两种写法，名字也排在前面）不会把正在装的包挤到上限之外。
        let mut others: BTreeMap<String, Vec<String>> = (0..2)
            .map(|i| (format!("sfly-u{i:02}"), vec!["sfly-zeta>=2".to_string()]))
            .collect();
        for i in 0..25 {
            others.insert(
                format!("sfly-x{i:02}"),
                vec![format!("aa{i:02}<1"), format!("aa{i:02}>=1")],
            );
        }

        let note = conflict_note(
            "sfly-zeta@1.0.0",
            &[],
            "sfly-zeta",
            Some("1.0.0"),
            &others,
            &uv_output("sfly-zeta", "1.0.0", ""),
        )
        .expect("note");

        let own = note.find("sfly-zeta：").expect("own group listed");
        let other = note.find("aa00：").expect("another group listed");
        assert!(own < other, "{note}");
        assert!(
            note.contains("sfly-u01（已安装） 要求 sfly-zeta>=2"),
            "{note}"
        );
        assert!(note.contains("没有列出"), "{note}");
    }

    #[test]
    fn at_most_twenty_pairs_are_listed_and_the_rest_are_counted() {
        let others: BTreeMap<String, Vec<String>> = (0..40)
            .map(|i| (format!("sfly-u{i:02}"), vec!["sfly-base>=2".to_string()]))
            .collect();

        let note = conflict_note(
            "sfly-base@1.0.0",
            &[],
            "sfly-base",
            Some("1.0.0"),
            &others,
            &uv_output("sfly-base", "1.0.0", ""),
        )
        .expect("note");

        let pairs = note.lines().filter(|l| l.contains(" 要求 ")).count();
        assert_eq!(pairs, 20, "{note}");
        // 正在装的那一条加 40 个挡路的，一共 41 对，列了 20 对。
        assert!(note.contains("另有 21 对没有列出"), "{note}");
        assert!(note.contains("怎么办"), "{note}");
        // 不超过上限时不写这一句。
        let few: BTreeMap<String, Vec<String>> = (0..19)
            .map(|i| (format!("sfly-u{i:02}"), vec!["sfly-base>=2".to_string()]))
            .collect();
        let note = conflict_note(
            "sfly-base@1.0.0",
            &[],
            "sfly-base",
            Some("1.0.0"),
            &few,
            &uv_output("sfly-base", "1.0.0", ""),
        )
        .expect("note");
        assert!(!note.contains("没有列出"), "{note}");
        assert_eq!(note.lines().filter(|l| l.contains(" 要求 ")).count(), 20);
    }

    /// 在 `dir` 里写一个 wheel（zip），`entries` 是（zip 里的路径，内容）。
    fn wheel_file(dir: &std::path::Path, filename: &str, entries: &[(&str, &str)]) -> PathBuf {
        use std::io::Write as _;
        let path = dir.join(filename);
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        for (name, content) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(content.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        path
    }

    #[test]
    fn the_metadata_of_the_dist_info_that_matches_the_wheel_file_name_is_read() {
        let dir = tempfile::tempdir().unwrap();
        // 别的包的 dist-info 排在前面：读的是和文件名对得上的那一份（uv 也是）。
        let wheel = wheel_file(
            dir.path(),
            "sfly_base-1.0.0-py3-none-any.whl",
            &[
                (
                    "other-9.9.dist-info/METADATA",
                    "Name: other\nVersion: 9.9\nRequires-Dist: evil>=1\n",
                ),
                (
                    "Sfly_Base-1.0.0.dist-info/METADATA",
                    "Name: sfly-base\nVersion: 1.0.0\nRequires-Dist: httpx>=0.25\n",
                ),
            ],
        );

        assert_eq!(wheel_version(&wheel).as_deref(), Some("1.0.0"));
        assert_eq!(wheel_requires(&wheel), ["httpx>=0.25"]);

        // 没有对得上的：读不出来，不拿别的包的顶替。
        let none = wheel_file(
            dir.path(),
            "sfly_base-2.0.0-py3-none-any.whl",
            &[(
                "other-9.9.dist-info/METADATA",
                "Name: other\nVersion: 9.9\nRequires-Dist: evil>=1\n",
            )],
        );
        assert_eq!(wheel_version(&none), None);
        assert!(wheel_requires(&none).is_empty());
        // 不是 wheel 的文件名、不是 zip。
        let not_wheel = wheel_file(dir.path(), "something.zip", &[]);
        assert_eq!(wheel_version(&not_wheel), None);
        std::fs::write(dir.path().join("sfly_base-3.0.0-py3-none-any.whl"), "x").unwrap();
        assert_eq!(
            wheel_version(&dir.path().join("sfly_base-3.0.0-py3-none-any.whl")),
            None
        );
    }

    #[test]
    fn the_version_and_the_requirements_come_from_the_headers_only() {
        let dir = tempfile::tempdir().unwrap();
        let metadata = |text: &str| {
            wheel_file(
                dir.path(),
                "sfly_base-1.0.0-py3-none-any.whl",
                &[("sfly_base-1.0.0.dist-info/METADATA", text)],
            )
        };

        // 空行后面是长描述：里面写着 `Version:`、`Requires-Dist:` 都不是元数据。
        let wheel =
            metadata("Name: sfly-base\nSummary: x\n\nVersion: 9.9\nRequires-Dist: evil>=1\n");
        assert_eq!(wheel_version(&wheel), None);
        assert!(wheel_requires(&wheel).is_empty());

        // `Version` 是空的：不当作版本。
        assert_eq!(wheel_version(&metadata("Name: x\nVersion:\n")), None);
        assert_eq!(wheel_version(&metadata("Name: x\nVersion:   \n")), None);

        // 头的名字不分大小写，续行不是新的头，只在某个 extra 下才要的依赖不算。
        let wheel = metadata(
            "name: x\nsummary: a long one\n  Version: 9.9\nversion: 1.0.0\nREQUIRES-DIST: a>=1\n  \
             Requires-Dist: evil>=1\nRequires-Dist: b>=2 ; extra == 'dev'\n\
             Requires-Dist: c>=3 ; python_version >= '3'\n\nbody\n",
        );
        assert_eq!(wheel_version(&wheel).as_deref(), Some("1.0.0"));
        assert_eq!(
            wheel_requires(&wheel),
            ["a>=1", "c>=3 ; python_version >= '3'"]
        );
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
