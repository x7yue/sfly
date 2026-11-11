# 编排场景

用户新建场景，在全屏画布上从「添加节点」菜单把节点包里的节点接到链尾，在检查器里填参数、选执行的 Agent，然后保存。每次保存都生成一个新版本。

## Sub-features

- `scn-create`：新建场景，自带一个 `entry` 入口节点，建好后进入画布。
- `scn-add-node`：工具条「添加节点」菜单可以搜索，新节点接在主链链尾。
- `scn-inspector`：检查器按输入 schema 生成表单，可以在常量和引用之间切换。
- `scn-default-agent`：「场景设置」里的「默认 Agent」，节点默认跟随它。
- `scn-save`：字段校验通过后才能保存，状态变成「已保存」，版本号加一。

## How to get to it (user POV)

- 「场景编排」页（`/orchestrations`）的「新建场景」按钮，空列表里也有一个。
- 命令面板 `Ctrl+K`，选 `option "新建场景"`。
- 场景卡片上的「编排」按钮，进入已有场景的画布（`/orchestrations/<id>`）。
- 添加节点：工具条按钮「添加节点」；在画布或节点卡片上按 `Tab` 或 `/`。
- 保存：顶部「保存 Ctrl S」按钮，或者按 `Ctrl+S`。

## Driving it with agent-browser

Preconditions:

- 基线环境，`sfly-stub@0.1.0` 已发布，没有叫「验证回显」的场景。

- **新建。** 打开 `$HTTP_URL/orchestrations`，先运行 `find role button click --name "新建场景"`，再用 `snapshot` 取 `@ref`：对话框里有 `textbox "名称"`、`textbox "说明"`，`新建` 按钮在填好名称之前是禁用的。名称填 `验证回显`，点 `新建`，URL 变成 `/orchestrations/<uuid>`，画布 `region "编排画布：验证回显"` 里只有 `entry` 一个节点。
- **默认 Agent。** 先 `snapshot -i -c` 找到 `combobox "默认 Agent" [ref=eN]`，再运行 `agent-browser $S select @eN "verify-agent"`（`find` 不支持 select），选中后选项文字是 `verify-agent · 在线 · 0/4 槽位`。
- **添加节点。** 点 `button "添加节点"`，再运行 `find role combobox fill "回显" --name "搜索节点类型"`，点 `option "回显 echo"`。画布上出现 `echo_1`，和 entry 之间有一条链；顶部提示变成「1 条警告」，因为必填输入还没填。
- **填参数。** 在 `textbox "输入 text"` 里填 `"你好 sfly"`，带 JSON 引号。警告消失，`combobox "节点 Agent"` 显示 `跟随默认（verify-agent）`。
- **保存。** 点 `button "保存 Ctrl S"`，页面上出现「已保存」，标题旁边显示 `v1`，画布上的节点卡片显示 `text = 你好 sfly`。
- **证据。** 截图 `scn-01-canvas-saved.png`，再存 `curl -s $HTTP_URL/api/orchestrations/<id> > $RUN/evidence/scn-orchestration.json`，用来确认版本号和文档里的节点。

## Gotchas

- `text` 这类没有类型注解的输入（`Any`）要填 JSON：直接填 `你好 sfly` 会提示「不是合法的 JSON」，保存按钮也是禁用的。`str` 类型的输入填普通文字就行。
- 有字段错误时「保存」按钮是禁用的，点它 agent-browser 会报 `is disabled`。先看顶部的「N 处字段错误」或「N 条警告」。
- 未保存的修改会作为本地草稿留在浏览器的 localStorage 里，刷新后还在。从干净状态开始验证时，用新的浏览器会话（换一套环境），或者先保存。
- 没设默认 Agent 也没设节点 Agent 时，触发会被「触发前检查」拦下来。
