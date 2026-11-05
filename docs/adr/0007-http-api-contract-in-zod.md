# HTTP API 的请求与响应 schema 统一用 zod 定义在 @sfly/schema

MVP 中前端使用的接口响应类型是手写副本，只靠注释"与控制面一致"来保证。改为：HTTP API 的请求和响应 schema 都在 `@sfly/schema` 中用 zod 定义一份，控制面用它校验请求、约束响应，前端用它推导类型并在开发环境做运行时校验。这与"线上协议用 protobuf、文档格式用 zod，各自只有一个来源"的原则一致，只是把 HTTP API 也纳入 zod 这一份。
