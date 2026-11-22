# 助手服务（apps/assistant）

助手服务在单独的助手容器里拉起和看管 pi，把 pi 的事件翻成平台的会话事件，执行控制面发来的命令。设计、协议、
一轮的规则见 `docs/ARCHITECTURE.md`「助手服务」一节，协议的类型在 `packages/schema/src/assistant-protocol.ts`。
这里只写开发时怎么跑。

```sh
pnpm --filter @sfly/assistant test        # 单测和集成测试（真的 pi、假的模型、假的工作台），macOS、Linux 都能跑
pnpm --filter @sfly/assistant typecheck
pnpm bundle:assistant                     # 组装镜像的构建上下文 out/assistant/
```

## 本机起一套：真的助手服务接真的工作台

联调时要的是三样真的：助手镜像、一台有能力端口的 Agent 当工作台、（之后）控制面。Agent 只能在 Linux 上编译，
在 macOS 上用评测集的环境：它的 `dev` 容器里就是一台真的 Agent（名字 `dev-root-dev`，能力端口 `dev:50052`），
助手容器接到同一个 Docker 网络上就能连到它。下面第 1–4 步在 macOS 上照着跑过一遍（假的模型端点，不花钱）；第 5 步接控制面等 #561 合入后补核。命令都从仓库根目录执行。

### 1. 起评测环境

```sh
cd evals/assistant
./aeval.sh --slot 1 up                    # 断网的机器：up --offline --isolated（离线包见 evals/assistant/README.md）
./aeval.sh --slot 1 reset                 # 起 Agent：up 之后能力端口还没开（实测），reset 重启它
cd ../..
```

网络是 `sfly-aeval-1`，工作台容器是 `sfly-aeval-1-dev`。确认 Agent 的能力端口开着：

```sh
docker exec sfly-aeval-1-dev bash -c '(echo > /dev/tcp/127.0.0.1/50052) && echo open'
```

不通时再 `./aeval.sh --slot 1 reset` 一次。助手服务按「两边路径相同」工作：工作区在工作台上和助手容器里
是同一个路径。控制面给的工作区是 `/work`；手动驱动时可以用它下面的一个目录，先在工作台上建好：

```sh
docker exec sfly-aeval-1-dev mkdir -p /work/proj
```

### 2. 模型

模型文件是 pi 的格式（`models.json`），密钥写成 `"$变量名"`，值经同名环境变量交给助手容器；助手服务只把模型文件
引用到的变量传给 pi。不想花钱时用评测集的假模型端点 `evals/assistant/container/fake_model.py`：它照剧本回复，
提示里写 `AEVAL-SCRIPT:<名字>` 时用和它同目录的 `<名字>.json`，`--dump <目录>` 把收到的每个请求存下来
（看发给模型的系统提示和消息；这两样在 #580 里加的，合入之前用
`git show origin/impl/539-rpcprobe:evals/assistant/container/fake_model.py` 取那一版）。在网络里随便一个有 python3 的容器里起它，例如工作台容器：

```sh
docker exec sfly-aeval-1-dev mkdir -p /tmp/fm
docker cp evals/assistant/container/fake_model.py sfly-aeval-1-dev:/tmp/fm/
cat > /tmp/demo.json <<'EOF'
{"steps":[
 {"id":"write","tool":"write","args":{"path":"notes/a.txt","content":"hello\n"}},
 {"id":"bash","tool":"bash","args":{"command":"cat notes/a.txt; ls .agents/skills","timeout":30}},
 {"id":"done","text":"做完了。"}
]}
EOF
docker cp /tmp/demo.json sfly-aeval-1-dev:/tmp/fm/demo.json
docker exec -d sfly-aeval-1-dev sh -c \
  'exec python3 /tmp/fm/fake_model.py --port 8101 --tasks /nonexistent --dump /tmp/fm/dump > /tmp/fm/log 2>&1'

mkdir -p /tmp/assistant-cfg
cat > /tmp/assistant-cfg/models.json <<'EOF'
{"providers":{"fake":{"name":"fake","baseUrl":"http://dev:8101/v1","api":"openai-completions","apiKey":"$FAKE_KEY",
 "models":[{"id":"fake","name":"fake","reasoning":false,"input":["text"],"contextWindow":128000,"maxTokens":8192,
 "cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}}]}}}
EOF
```

接真的模型时换成真的端点和 `"$变量名"`，`docker run` 时用 `-e 变量名` 从宿主的环境带进去（不要把值写在命令行里）。

### 3. 构建和起助手容器

```sh
pnpm bundle:assistant
docker build -f apps/assistant/Dockerfile --build-arg NODE_MAJOR="$(cat .node-version)" -t sfly-assistant:dev out/assistant

export SFLY_ASSISTANT_SECRET="$(openssl rand -hex 24)"   # 至少 32 个字符；控制面那边配同一个
docker run -d --name sfly-aeval-1-assistant --network sfly-aeval-1 --init --memory 2g \
  -e SFLY_ASSISTANT_SECRET -e SFLY_ASSISTANT_MODEL=fake/fake -e FAKE_KEY=k \
  -v /tmp/assistant-cfg/models.json:/config/models.json:ro \
  sfly-assistant:dev
docker logs sfly-aeval-1-assistant      # 「助手服务在 :8090（pi 1.6.0）」
```

`./aeval.sh --slot 1 down` 不认识这个容器：收尾时先 `docker rm -f sfly-aeval-1-assistant` 再 `down`，不然网络删不掉。助手服务只在容器网络里听 8090；要从宿主机直接调，
加 `-p 127.0.0.1:8090:8090`。

### 4. 不经控制面，直接驱动一轮

协议是 HTTP：`POST /sessions/<会话 ID>/prompt` 开始一轮（202，先回应再拉起 pi），`POST /sessions/<会话 ID>/abort`
停止，`GET /events` 是 NDJSON 的事件流（第一行 `hello`，之后是事件记录），`GET /health` 看版本和进程数；
每个请求带 `Authorization: Bearer <共享密钥>`。在助手容器里用 node 发（它有 `fetch`）：

```sh
docker exec -e S="$SFLY_ASSISTANT_SECRET" sfly-aeval-1-assistant node --input-type=module -e '
const auth = { authorization: `Bearer ${process.env.S}` };
const id = crypto.randomUUID();
const events = await fetch("http://127.0.0.1:8090/events", { headers: auth });
const reader = events.body.pipeThrough(new TextDecoderStream()).getReader();
const res = await fetch(`http://127.0.0.1:8090/sessions/${id}/prompt`, {
  method: "POST", headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify({ turn: 1, message_id: crypto.randomUUID(), text: "AEVAL-SCRIPT:demo 照剧本做。",
    session: { title: "联调", created_by: "me" },
    workbench: { name: "dev-root-dev", address: "dev:50052", workdir: "/work/proj" },
    env: { SFLY_NICKNAME: "me", AI_AGENT: "pi" }, secret_env: {} }) });
console.log("prompt", res.status);
for (let buf = ""; ; ) {
  const { value, done } = await reader.read(); if (done) break;
  buf += value; const lines = buf.split("\n"); buf = lines.pop();
  for (const line of lines) { console.log(line); if (line.includes("\"turn_end\"")) process.exit(0); }
}'
```

看到的应该是 `tool_call` / `tool_result`（写、命令）、`assistant_message`，最后 `turn_end`（`completed`）。之后：

- 工作台上：`docker exec sfly-aeval-1-dev cat /work/proj/notes/a.txt`；skill 在 `/work/proj/.agents/skills/`，和镜像里的一致。
- 助手容器里：`/work/proj/.agents/skills/` 是同一份（pi 从这里读），别的文件都在工作台上；
  `/data/sessions/<会话 ID>/` 下是 pi 的原始事件 `events.jsonl`、`pi-stderr.log`、pi 的会话文件 `pi-session/`。
- 发给模型的请求：`docker exec sfly-aeval-1-dev ls /tmp/fm/dump`。

停止：一轮在做时 `POST /sessions/<会话 ID>/abort`，这一轮以 `stopped` 结束，工作台上正在跑的命令随连接断开结束；
同一个会话 ID、`turn` 加一再发一句就是接着说。

### 5. 接控制面

控制面（#541 起）配三个环境变量就会把会话交给这个助手服务：`SFLY_ASSISTANT_URL=http://sfly-aeval-1-assistant:8090`
（控制面和助手容器在同一个网络里时；不在时用助手容器映射出来的地址）、`SFLY_ASSISTANT_SECRET`（和上面同一个）、
`SFLY_WORKBENCH_AGENT=dev-root-dev`。控制面把工作台 Agent 上报的地址和端口、工作区 `/work` 交给助手服务，所以
助手容器要能按 Agent 上报的地址连到它（评测环境里是 `dev:50052`）。控制面怎么建会话、发话见
`docs/ARCHITECTURE.md`「助手会话」一节。

### 常见问题

- **这一轮以 `failed` 结束、原因是写不了 skill**：连不上工作台的能力端口。在助手容器里试
  `node -e 'require("net").connect(50052,"dev").on("connect",()=>{console.log("ok");process.exit()})'`。
- **`interrupted`、pi 起不来**：看 `/data/sessions/<会话 ID>/pi-stderr.log` 和 `docker logs`；模型文件里引用的变量
  没有带进容器时 pi 起来了也调不了模型，结局是 `model_unavailable`。
- **503 `process_limit`**：同时活着的 pi 进程到了 8 个、都在做。
- **工作区不是 `/work` 下的目录**：助手容器里要能建同一个路径（镜像里只有 `/work` 归运行用户）。
