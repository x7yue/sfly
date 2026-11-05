# 前端是纯 SPA，由控制面在同一端口托管静态文件

前端不使用 SSR：页面都是需要实时数据的内网工具界面，首屏是画布或监控视图，SSR 没有收益，还要求单独部署一个 Node 服务并在服务端代理 API。改为 TanStack Router + TanStack Query 构建的 SPA，构建产物由控制面托管，与 HTTP API、SSE 同源同端口；生产环境不再依赖 vite，也不需要 `/api` 代理。这推翻了 MVP 中"使用 TanStack Start"的选择（ADR 0003 中与前端共用 schema 的理由不受影响）。

## Considered Options

- **保留 TanStack Start 的 SSR，单独部署 Node 服务**：多一个服务和一层代理，换不来实际收益。
- **SPA 由独立的静态服务器或 nginx 托管**：运维多一个组件，跨源还要处理 CORS 和 SSE。
