# 编码规范

代码审查逐条检查本文。这里只放需要判断的规则；能机械检查的写进 lint 或测试（biome、ruff、clippy、`biome-plugins/`）。

其他规范来源，审查时一并对照：

- `GLOSSARY.md`：术语。
- `docs/DESIGN-SYSTEM.md`：界面、样式与文案。
- `docs/guide/sdk-reference.md`：节点代码的写法（sfly-std 是范例，同样适用）。
- `docs/SEMANTICS.md`：调度与状态语义。

## 测试

- **异步结果在等待条件里断言。** 触发异步动作（发消息、派发、取消、杀进程、写库）之后，要断言的状态放进等待条件，
  等它落定再继续：TS 用 `test/support/eventually.ts`，Agent 测试用 `wait_until`/`wait_for`，Python 用文件里的 `wait_for`。
  - 不在动作之后立即断言。
  - 不先 sleep 固定时长再断言。e2e 里的 `waitForTimeout` 由 `biome-plugins/e2e-fixed-wait.grit` 拦下；确实只能等一段时间、确认某件事没有发生时，
    在它上一行写 `// biome-ignore lint/plugin/e2e-fixed-wait: <原因>`。
  - 耗时只作超时上限，不作断言区间（例如 `0.45 <= elapsed < 2`）。

  这类写法在 CI 的 2 核 runner 和本机高负载时会偶发失败（#108、#129、#136）。
- **断言路径时用真实路径。** 命令行和被测代码输出的是 resolve 过的路径，临时目录经过符号链接（macOS 的 `/tmp`、`/var`）时和 `tmpdir()` 不同：
  建临时目录后 `realpath` 一次，再拿它拼路径。
- **测试只碰自己建的东西**：临时目录、端口、数据库、git 仓库。
  - 测试里启动 git 子进程时去掉继承来的 `GIT_*` 变量。
  - 不依赖 GNU coreutils 的特有行为：CI 的 Ubuntu 用 Rust 版 coreutils，复制改名后的系统命令会拒绝运行。
- **修偶发失败的 PR 写明加压复现**：修复前在加压下失败几次，修复后跑多少次全部通过（`pnpm test:stress`，e2e 用 `pnpm test:e2e:stress`，macOS 上它在 Docker 里运行）。
  不能只靠调大超时；确实要调时，写明原来的超时为什么不合理。
- **PR 里新增或改动的 e2e spec 在 CI 里会重复运行几次**（`pnpm test:e2e:changed`）：那一步失败说明用例不稳定，不要重跑碰运气；
  本地用 `pnpm test:e2e:stress $(bash scripts/e2e-changed.sh --list)` 复现。

## 文档

- **已接受的 ADR 是当时的决定记录，改名或换做法时不回头改它的正文。** 命令、接口、术语改名后，ADR 里的旧名照旧保留：读者要能看到当时决定的是什么。
  决定被推翻时写一份新的 ADR，在旧 ADR 末尾加一行指向它（例如「已被 ADR 0021 取代」）。现行的说明写在 `docs/ARCHITECTURE.md`、`docs/guide/` 和 GLOSSARY 里，这些随改名一起改。
