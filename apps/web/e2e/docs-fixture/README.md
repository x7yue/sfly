# 开发文档页的固定文档

`docs.spec.ts` 和 `visual.spec.ts` 的「开发文档」用这里的文档，不随 `docs/guide/` 变化。控制面只加载 `pages.json` 列出的页面，这份 README 不会出现在页面上。

改了这里的任何文件，「开发文档」的 3 张视觉基线（`docs.png`、`docs-light-scheme.png`、`docs-narrow.png`）都会变，同一个提交里重新生成：

```bash
pnpm test:e2e:docker visual.spec.ts --grep 开发文档 --update-snapshots
```
