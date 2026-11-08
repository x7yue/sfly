# 发版性能报告

每个平台版本发版前跑的性能测试报告（ARCHITECTURE §7.6），随发版 PR 提交，之后的 `pnpm perf` 拿最近一个版本的报告作为「发版基线」对比。

- `<版本>/report.json`、`<版本>/report.md`：`pnpm perf --release` 的报告；
- `<版本>/soak.json`、`<版本>/soak.md`：维护者要求跑长时负载测试时，`pnpm perf:soak --release` 的报告。

这些文件只由 `--release` 写入：它只收完整运行、没有被中断、结论通过、运行时没有未提交改动的结果，不要手动修改或从别处复制进来。
发版步骤见 `docs/agents/branching-and-release.md`「发版」。平时运行的结果在本机结果目录（默认 `~/.local/share/sfly/perf/`），不放这里。
