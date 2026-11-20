# 领域文档

## Before exploring, read these（动手前先读）

- `GLOSSARY.md`（仓库根目录）：统一术语。
- `docs/adr/`：读与你要改的区域有关的 ADR。

## Use the glossary's vocabulary（用术语表的词）

产出里提到领域概念时（issue 标题、改动方案、测试名、界面文案、日志和错误信息、PR 标题），用 `GLOSSARY.md` 里定义的词，不用它的 `_Avoid_` 行列出的说法。

术语表里没有你需要的概念：要么是你在发明项目不用的说法，换回已有的词；要么是术语表确有缺口，在 PR 描述里写出来。

## Flag ADR conflicts（ADR 冲突要明说）

产出与已有的 ADR 矛盾时，明说，不要悄悄覆盖：

> _与 ADR 0007（HTTP API 的契约用 zod 定义）矛盾，但值得重新讨论，因为……_

推翻已接受的 ADR：写一份新的 ADR，在旧 ADR 末尾追加一行指向它（例如「已被 ADR 0021 取代」），不改旧 ADR 的正文（`CODING_STANDARDS.md`「文档」；`pnpm lint:docs` 会拒绝）。
