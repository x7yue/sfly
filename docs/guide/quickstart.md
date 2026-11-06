# 快速开始

> 本页是占位内容，完整的开发文档见后续版本。

sfly 是测试编排平台：节点包里用 `@node` 声明的 Python 函数由测试机上的 **sfly Agent** 执行，在控制面上编排成场景运行。当前控制面的地址是 `{{SFLY_URL}}`，版本 `{{SFLY_VERSION}}`。

## 流程

1. 在测试机上接入 sfly Agent。
2. 初始化一个节点包项目，写节点和单元测试。
3. 本地调试，再在本机 Agent 上联调。
4. 构建并发布节点包，在场景里使用它。

## 读取这份文档

AI 编程助手可以直接读取原文，所有页面的地址列在索引里：

```sh
curl -s {{SFLY_URL}}/llms.txt
curl -s {{SFLY_URL}}/docs/quickstart.md
```

| 地址 | 内容 |
|---|---|
| `/llms.txt` | 全部页面的原文地址 |
| `/docs/<页>.md` | 一页的 Markdown 原文 |

节点包的发布与管理见 [节点包管理](/packages) 页面。
