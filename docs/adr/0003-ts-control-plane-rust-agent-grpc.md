# 控制面用 TypeScript，Agent 用 Rust，两者之间用 protobuf + gRPC 双向流

控制面使用 TypeScript（Fastify + PostgreSQL），这样编排文档的 schema 可以和 TanStack Start 前端共用，引擎逻辑迭代也快；Agent 使用 Rust，编译成单个二进制文件，机器上只需要 `uv`，进程树终止可靠，资源占用低；节点 SDK 只能用 Python，因为节点包是 Python wheel。由于协议两端是不同的语言，Agent ↔ 控制面的通信采用 protobuf 定义唯一契约（由 buf 做兼容性检查），传输层使用 gRPC 双向流：连接由 Agent 主动发起，控制面通过这条流推送任务和取消指令，不需要自己实现帧、心跳和错误码。

## Considered Options

- **WebSocket + JSON（JSON Schema 生成类型）**：调试方便，但跨语言的类型生成较弱，帧、ack、心跳都要自己实现。
- **HTTP 长轮询**：最简单，但取消指令无法即时送达，实时日志需要频繁请求。
- **消息中间件（NATS 等）**：需要多运维一套基础设施，而且投递状态要和数据库对齐。
- **控制面用 Rust 或 Python**：Rust 拖慢业务逻辑的迭代；Python 无法与前端共用 schema。

## Consequences

- 团队需要同时维护三种语言：TS、Rust、Python。
- Python 执行器与 Agent 之间不使用 protobuf，而是用 JSON 文件和环境变量通信（见 ADR 0002）。
