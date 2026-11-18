# 画布分组框、注释框与便签调研

调研日期：2026-11-17。源码链接固定到调研时各仓库的提交或标签，没有版本号的文档页按当天的内容引用。

背景：场景作者反馈注释框「考虑不全面」，而且「注释只写在框头，很难区分节点和注释框」。这份调研看主流节点编辑器和画布工具怎样做分组框、注释框和便签，并和 sfly 现在的注释框对照。sfly 现在的做法是：只记成员，范围自动贴合；中性灰实线框，框里是暗一档的不透明底；左上角一个圆角标题带；备注只能悬停图标看。

## 1. 摘要与对 sfly 的建议

**结论：sfly 的成员模型没有大问题，问题出在外观和备注放在哪里。**

- 成员模型：「显式记成员、框自动贴合」和 Node-RED、n8n Canvas Groups、Unity Shader Graph、Blender（默认）是同一类做法。
- 外观：在调研的产品里，只有 sfly 把框标题做成了一个独立的、和节点卡片同形的小块，即深色圆角小块加粗体字，还带同一个备注图标。Airflow 3 的组和任务虽然用同一种卡片画，但组展开后标题只是大框里的第一行；收起后靠组图标、「Task Group」字样和卡片下面叠的两条窄条来和任务区分（§3.6）。
- 备注：sfly 的备注只能悬停一个小图标才能看到。在调研的产品里，这是最难读到的一种。
- 主流产品都把「圈出一组节点」和「写下说明」分开处理，而且框总是背景、节点总是前景。

**对 sfly 最有借鉴意义的做法：**

1. **框的标题不要长得像节点。** 主流只有两种做法，没有哪家把框标题做成独立、浮起、和节点卡片同样的圆角块。
   - 第一种是横跨整个框宽的标题栏，和框同一色系：
     - ComfyUI 的标题栏高 30，和框身用同一颜色、25% 透明度，标题栏叠了两层所以更深，见 §3.2。
     - n8n Canvas Groups 的标题栏和节点一样高（96），框身用虚线，见 §3.3。
     - UE、Houdini、Unity 都是顶栏。
   - 第二种是没有底块的纯文字：
     - Node-RED 在框内角落写一行小字，见 §3.1。
     - Blender 把标题居中写在框顶，不画分隔线，默认 20 号字，见 §3.9。
   - Blender frame 的默认外观和 sfly 的「暗井」最像：底色比画布暗，80% 不透明，没有描边。它靠的是标题不加底块、居中写在框顶，所以不会被看成节点。
   - 建议改成下面两种之一：
     - 把标题带改成贴着框上沿、横跨整个框宽的标题栏：和框同一个中性色，只比框身亮一档，不单独做圆角，也不浮起。
     - 去掉底块，只留大字标题。
   - 标题字号继续比卡片标题大，见第 4 点。

2. **备注要直接显示，不要只藏在悬停里。** 主流有三种做法：
   - **直接写在框里：**
     - Blender frame 可以挂一段文字，自动换行，超出框就截断。
     - TouchDesigner Annotate 有正文区。
     - n8n Canvas Groups 的描述最多 145 字，放在名字下面一行；缩放比例低于 0.66 时隐藏。
   - **另放一张便签：**
     - ComfyUI 有 Note 和 MarkdownNote。
     - n8n sticky note 支持 Markdown。
     - Houdini、Unity、FigJam 都有 sticky note。
     - Dify note 用富文本，Langflow note 用 Markdown。
   - **悬停或点开才看到：**
     - Airflow TaskGroup 用 tooltip。
     - n8n 的组折叠后，描述收进信息图标。
     - Make 的 notes：悬停预览，点开看全文，工具栏面板列出全部并能搜索。
     - Node-RED 把说明放在右侧信息栏。
   - 建议：
     - 把备注的前一两行直接显示在标题栏下面（n8n 的做法），长的截断，点框或在检查器里看全文。
     - 缩小视图时隐藏正文，只留标题。
     - 节点卡片空间小，备注仍用图标；框上不再用同一个图标，这样两者一眼就能分开。

3. **颜色不是必需的。**
   - 大多数产品允许用户选色。
     - 预设色板：ComfyUI 9 色、Dify 6 色、n8n sticky 7 色加任意色、Langflow 5 色加透明加任意色、Node-RED 36 色、FigJam 约 18 色。
     - 任意色：UE、Nuke、TouchDesigner、Airflow、Blender。
   - 也有不给颜色的：
     - n8n Canvas Groups 的数据里根本没有颜色字段。
     - Unity Shader Graph 的 group 是固定的淡灰，透明度约 0.1。
   - 只靠结构也能把框和节点分开，所以 sfly 设计体系「框只用中性灰」的限制不必改。
   - 以后要分清嵌套的框，可以按嵌套层数交替深浅，不引入新色相。Blender 是奇数层亮 20，Airflow 3 是偶数层用 `bg.muted`。

4. **缩小视图这一项 sfly 已经做得比多数产品好。**
   - 多数产品让框和标题跟着等比缩小，没有专门处理：Node-RED、ComfyUI、Dify、Langflow、Unity、Blender。
   - 做了专门处理的：
     - UE 官方文档说注释框的文字会跟着缩放，适合缩小后看全图。
     - n8n 缩放比例低于 0.66 时隐藏描述。
     - Airflow 2 缩放比例低于 0.5 时隐藏细节，并把边框加粗。
     - Houdini 建议把便签字号设大，远看时当标签用。
   - sfly 缩小视图时标题放大到 14px，比卡片标题大一号。这一点应保留。

5. **成员模型基本对，但「一个节点在几个框里、框之间还能交叉」很少见。**
   - 显式记录成员的产品全部规定一个节点最多属于一个框，框之间只能嵌套，不能交叉。这些产品是 Node-RED、n8n、Blender、Houdini、Unity、Figma、Airflow。其中 n8n 和 Unity 连嵌套都不支持。
   - 按几何位置判断成员的产品，框叠在一起时，一个节点才会同时属于两个框。这些产品是 ComfyUI（看节点中心点在不在框里）、UE（看在不在边界内）、Nuke（看有没有重叠）、TouchDesigner。不过这些框是用户自己摆的，不存在「自动贴合的框互相穿插」的问题。
   - 建议：保留「一个节点可以在几个注释框里」，但要求这几个框一个包住另一个，不允许两个框部分交叉。这样有两个好处：
     - 自动贴合的框不会互相穿插，标题也不会叠在一起。
     - 按注释框分段的一键整理布局更容易定义，见第 8 点。

6. **加入和移出要能直接拖。**
   - 各产品的拖拽做法：
     - Node-RED：拖到组上停一下就加入，按住 Alt 拖就移出。
     - Blender：拖到 frame 上松手就加入，拖的过程中按 F 可以切换加入或脱离。
     - Houdini：慢慢拖向边缘会把框撑大，快速拖出去就脱离。
     - Unity：拖到 group 上就加入。
     - n8n 的组约束很多，Airflow 的组由代码决定，这两家都不支持拖拽。
   - 快捷键：
     - 新建普遍是 Ctrl/⌘+G（ComfyUI、n8n、Unity），Node-RED 是 Ctrl/⌘+Shift+G。
     - 解散是 Ctrl/⌘+Shift+G 或 Ctrl/⌘+U。
   - 删除框时，Nuke、Houdini、Figma、Unity 会区分「只删框」和「连成员一起删」。
   - 建议：
     - 支持「拖到框上停一下就加入、按住 Alt 拖出」，并用 Ctrl/⌘+G 新建。
     - 删除注释框永远不删成员。按 GLOSSARY 的定义，注释框只用于说明。

7. **折叠和运行状态汇总可以放到下一步。**
   - 能折叠的产品：
     - n8n Canvas Groups 折叠成 400 宽的小块，折叠状态只存在浏览器里。
     - Houdini network box 折叠后只剩顶栏。
     - Airflow TaskGroup 收起成一张卡片。
     - FigJam section 可以隐藏内容。
     - ComfyUI 用子图代替折叠。
   - 在框上显示运行状态汇总的产品：
     - Airflow 由后端按固定优先级算出组的状态：失败排在最前，全部成功才算成功。结果画在边框色、徽章上，收起时还有一条分段状态条。
     - n8n 只在折叠时在小块上画汇总状态，展开时由成员节点自己显示。
     - Blender frame 显示子节点执行时间的总和。
   - 对 sfly：注释框只用于说明，不影响执行，折叠和汇总都不是必须的。如果要做：
     - 学 n8n，只在折叠时显示汇总，避免和成员节点的状态重复。
     - 颜色仍从状态表 `STATUS` 取。

8. **自动布局都把组当成一个整体。**
   - n8n 整理布局时先排组内成员，再把整组当成一个盒子参与排版。
   - Airflow 用 ELK 的层级节点（`hierarchyHandling: INCLUDE_CHILDREN`）。
   - React Flow 官方文档写明：Dagre 处理子流程有已知问题，ELK 支持子流程。
   - sfly 已经按注释框分段排版，方向是对的。但框一旦部分交叉，分段就没法定义，这也是第 5 点建议只允许嵌套的原因之一。

**sfly 现状与主流做法的主要差距：**

| 方面 | sfly 现状 | 主流做法 | 是否算差距 |
|---|---|---|---|
| 框标题的样子 | 左上角圆角深色小牌子，加粗体标题和备注图标，和节点卡片同形 | 横跨框宽的标题栏，或者没有底块的文字 | **是，最主要的差距** |
| 备注 | 只能悬停小图标看 | 直接写在框里，或另放一张便签；只靠悬停的很少 | **是** |
| 加入和移出 | 只能用右键菜单或检查器 | 拖进拖出（Node-RED、Blender、Houdini、Unity） | **是** |
| 框之间的关系 | 允许部分交叉 | 只能嵌套，或者不能嵌套 | **是**（会和自动贴合、分段布局冲突） |
| 折叠 | 不能 | 有分组框的 11 个产品里有 4 个支持（n8n Canvas Groups、Airflow、Houdini、FigJam） | 次要 |
| 运行时汇总 | 没有 | Airflow、n8n 有，Blender 显示耗时 | 次要 |
| 颜色 | 只有中性灰 | 多数能选；n8n Canvas Groups、Unity group 也不能 | 不算 |
| 大小 | 自动贴合，不能调 | Node-RED、n8n、Unity、Blender 默认也是这样 | 不算 |
| 空框 | 不能建 | Node-RED 允许空组（40×40）；几何派天生可以 | 看需要 |

「考虑不全面」可能对应下面几种情况。主流产品对每种情况都有明确的规则，sfly 也应该逐条定下来：

- **框之间是什么关系**：只能嵌套还是允许交叉，见第 5 点。
- **删框时成员怎么办**：Nuke、Houdini、Figma、Unity 都区分「只删框」和「连成员一起删」。
- **成员不合规时怎么办**：n8n 保存时发现不合规的组，会自动解散并给出提示。
- **只剩一个成员或没有成员时框还在不在**：n8n 要求至少 2 个成员；Node-RED 允许空组。
- **复制粘贴时带不带上框**：Node-RED 在 1.1.3 修过嵌套组的复制粘贴。
- **只读视图里框怎么显示**：n8n 的只读视图默认把组全部展开。

## 2. 对比表

| 产品 | 视觉区分（标题、填充、层级） | 说明文字 | 颜色 | 缩小视图 | 折叠 | 成员与大小 | 交互 | 自动布局 | 运行状态 |
|---|---|---|---|---|---|---|---|---|---|
| Node-RED group | 没有标题栏，框内角落一行小字；默认不填充，灰色 2px 描边，圆角 4；在节点下面 | 说明（Markdown）在右侧信息栏，不上画布 | 描边、填充、文字各自任意选色，另有 36 色预设 | 无特殊处理 | 不能 | 显式（组存成员列表，节点存所属组）；自动贴合，留白 26，不能手调 | Ctrl/⌘+Shift+G 新建；拖到组上停一下加入，Alt 拖出；可嵌套 | 没有自动布局 | 无 |
| ComfyUI group | 整条标题栏高 30，框和标题栏同色、25% 透明，标题栏更深；直角；标题 20 号；在节点下面 | 组只有标题；说明用 Note / MarkdownNote 节点 | 9 色预设 | 无特殊处理，等比缩小 | 不能（用子图代替） | 几何（节点中心在框里就算成员），成员关系不存盘；用户拖右下角调大小，另有「贴合内容」命令 | Ctrl+G 新建并贴合选中节点；拖标题栏整组移动；可钉住；完全被包住的组算子组 | 查不到 | 无 |
| n8n sticky note | 没有标题，整块浅色便签；在节点下面 | 便签本身就是正文（Markdown，能嵌视频） | 7 色预设加任意色 | 无特殊处理 | 不能 | 不记成员，只是视觉上垫在节点下面；用户调大小 | 从节点面板添加，双击编辑 | 盖在组上的便签随组一起移动 | 无 |
| n8n Canvas Groups | 标题栏与节点同高（96），实线，上边两角圆；框身是虚线；在节点下面 | 描述最多 145 字，在名字下一行；折叠后悬停信息图标看 | 没有颜色 | 缩放比例低于 0.66 时隐藏描述 | 能，折叠成 400 宽小块，折叠状态存在浏览器里 | 显式 `nodeIds`；自动贴合；一个节点只能在一个组里，成员必须连成一条链，不能含触发器，不能嵌套 | Ctrl/⌘+G 新建，Ctrl/⌘+Shift+G 解散；拖标题栏整组移动 | 整理布局时整组当一个盒子 | 折叠时在小块上显示汇总状态 |
| Dify note | 浅色底，顶部 8px 色条，没有标题，圆角约 6 | 富文本（Lexical），可以显示作者 | 6 色预设 | 无 | 不能 | 不是容器；用户调大小（最小 240×88） | 从工具栏添加，再点击落位 | 不参与整理布局 | 无 |
| Langflow note | 没有标题，圆角约 12，正文 16px；未选中时沉到节点下面 | Markdown（最多 2500 字） | 5 色预设加透明加任意色 | 无 | 不能 | 不是容器；用户调大小（最小 280×140） | 从工具栏添加 | 查不到 | 无（另有「合并成一个组件」的 Group，不是框） |
| Airflow TaskGroup（3.x） | 和任务同一种卡片，展开后变大包住子任务；标题是第一行加组图标；嵌套时交替深浅 | tooltip 悬停；`doc_md` 在详情面板 | `ui_color` 任意色，和底色按 22% / 45% 混合 | 无特殊处理（2.x：缩放比例低于 0.5 时隐藏细节） | 能，收起成卡片（下面叠两条窄条），展开状态存在浏览器里 | 显式（在 DAG 代码里定义）；大小由 ELK 算，不能拖 | 只能展开、收起 | ELK 层级布局，收起的组当一个节点 | 有：后端按优先级汇总，画成边框色、徽章、分段条 |
| UE Blueprint comment | 顶部标题栏，背景是半透明底色 | 只有标题；另有挂在单个节点上的气泡 | 任意色，带透明度 | 文字跟着缩放，便于看全图 | 不能 | 几何（边界内的节点随框移动）；用户拖右下角调大小 | 按 C 或「从选中创建」；每个框可设移动时带不带成员；可嵌套 | 查不到 | 查不到 |
| Blender frame | 没有标题栏，标题居中写在框顶（默认 20 号）；默认底色 #0f0f0f、80% 不透明，比画布 #1d1d1d 暗；有圆角，不描边（选中才描边）；嵌套时交替深浅 | 可以挂一段文字，直接画在框里，自动换行，超出截断 | 主题色或自定义色 | 无特殊处理 | 不能 | 显式父子关系；默认自动贴合（Shrink），关掉后可以手调 | 按 F 新建；拖到 frame 上松手加入，拖动中按 F 切换；可嵌套 | 没有自动布局 | 显示子节点执行时间之和 |
| Nuke Backdrop | 节点后面的框，可以拖标题栏，右下角三角缩放；可以只画边框（Border） | 只有标题 | 任意色 | 查不到 | 查不到 | 几何（和框重叠的节点随框移动）；用户调大小 | 删除有三种方式；可以当书签跳转 | 查不到 | 查不到 |
| Houdini network box / sticky note | 框有顶栏写标题，可以设透明度；sticky 是有色便签，可以去掉背景 | 框只有标题；说明用 sticky note | 色板 | 建议把便签字号设大，远看当标签 | 能，折叠后只剩顶栏 | 显式（`addItem`）；自动贴合默认关，有「贴合内容」命令 | 拖进拖出，快速拖出就脱离；可嵌套；删框时可选连内容一起删 | 折叠时可以挪开相邻节点 | 查不到 |
| TouchDesigner Annotate | 三种模式：Comment 没有标题，Network Box 有标题栏，Annotate 全功能；默认画在网格下面 | Annotate 有正文，直接显示；还能嵌入一个算子的实时画面 | 任意色加透明度 | 查不到 | 查不到 | 几何（开了 `encloseops` 时框里的算子随框移动）；用户调大小，节点拖到边上框会变大 | Shift+C/B/A 新建；拖标题栏整组移动，Alt 只移框；点正文区会穿透到下面的网络 | 查不到 | 查不到 |
| Figma / FigJam section | 名字牌（样式文档里没写）；Fill、Stroke 可改 | section 只有名字；说明用 sticky 或文本 | FigJam 约 18 色预设加任意色 | 查不到 | FigJam 可以隐藏内容 | 显式父子关系，但用几何操作加入（盖住、拖入）；用户调大小 | Shift+S 新建；可嵌套；删框时可保留内容 | 不适用 | 「Ready for dev」状态显示在名字旁（手动标记，内容改了自动变成 Changed） |
| Unity Shader Graph group / sticky note | group 有标题栏，背景淡灰、透明度约 0.1，只有点标题栏才能选中；sticky 是黄色或暗棕色的不透明便签 | group 只有标题；sticky 有标题和正文，4 档字号（20 到 80） | group 不能选色；sticky 只有亮、暗两种 | 无特殊处理 | 不能 | 显式（成员记在节点上）；自动贴合，不存大小；不能嵌套 | Ctrl+G 新建，Ctrl+U 移出，拖到 group 上加入 | 没有 | 无 |
| Make.com notes | 挂在模块或路由上的一个标记，不是框 | 悬停预览，点开看全文（富文本），工具栏面板列出全部、可搜索 | 查不到 | 查不到 | 不适用 | 没有分组功能 | 右键模块选「Add a note」 | 不适用 | 不适用 |
| React Flow group（库） | 没有标题栏的半透明矩形（默认 `rgba(240,240,240,0.25)`，1px 边框，圆角 3） | 没有 | CSS 任意设 | 没有内置处理 | 没有内置 | 显式 `parentId`，子节点坐标相对父节点；不自动贴合（`expandParent` 只会变大） | 库只提供能力：`extent: 'parent'`、`NodeResizer` | 官方建议用 ELK | 没有 |
| **sfly 注释框（现状）** | 中性灰实线框，框里是比画布暗一档的不透明底；左上角圆角标题带（粗体标题加备注图标），和节点卡片同形 | 只能悬停备注图标看 | 只有中性灰 | 标题放大到 14px | 不能 | 显式成员，自动贴合，不能手调；一个节点可以在几个框里，框之间可以交叉 | 用右键菜单或检查器加入、移出；多选后新建；拖标题带整组移动 | 按注释框分段 | 无 |

## 3. 各产品细节

### 3.1 Node-RED groups

版本：仓库 `e4f7fc5`（2026-11-13）。groups 从 1.1 版（2020-06）开始有。

- **外观**：没有标题栏。组是 SVG 画的一个圆角矩形，加一行文字标签（[view.js L6700-L6760](https://github.com/node-red/node-red/blob/e4f7fc516cd8da1b4b4d571169cf6937b500bb30/packages/node_modules/@node-red/editor-client/src/js/ui/view.js#L6700-L6760)）。
  - 标签位置可以选 nw / ne / n / sw / se / s，默认 nw，也就是左上角在框里面。
  - 浅色主题默认不填充，描边 `#999`，标签文字 `#767676`（[colors.scss L315-L319](https://github.com/node-red/node-red/blob/e4f7fc516cd8da1b4b4d571169cf6937b500bb30/packages/node_modules/@node-red/editor-client/src/sass/colors.scss#L315-L319)）。深色主题描边 `#555555`（[dark-colors.scss L291-L296](https://github.com/node-red/node-red/blob/e4f7fc516cd8da1b4b4d571169cf6937b500bb30/packages/node_modules/@node-red/editor-client/src/sass/dark-colors.scss#L291-L296)）。
  - 描边宽 2（[flow.scss L178-L189](https://github.com/node-red/node-red/blob/e4f7fc516cd8da1b4b4d571169cf6937b500bb30/packages/node_modules/@node-red/editor-client/src/sass/flow.scss#L178-L189)），圆角 4，选中时外面再描一圈（[view.js L6541-L6571](https://github.com/node-red/node-red/blob/e4f7fc516cd8da1b4b4d571169cf6937b500bb30/packages/node_modules/@node-red/editor-client/src/js/ui/view.js#L6541-L6571)）。
  - 组所在的图层在节点图层下面（[view.js L719-L720](https://github.com/node-red/node-red/blob/e4f7fc516cd8da1b4b4d571169cf6937b500bb30/packages/node_modules/@node-red/editor-client/src/js/ui/view.js#L719-L720)）。
  - 标签字号没有单独设置，继承 SVG 默认值，具体数值查不到。
- **说明文字**：编辑对话框里有 Description 页，内容是 Markdown。选中组时，说明显示在右侧信息栏，不画在画布上（[官方文档](https://nodered.org/docs/user-guide/editor/workspace/groups)）。
- **颜色**：描边、填充、标签三者各自选色，各带透明度（[group.js L98-L141](https://github.com/node-red/node-red/blob/e4f7fc516cd8da1b4b4d571169cf6937b500bb30/packages/node_modules/@node-red/editor-client/src/js/ui/group.js#L98-L141)）。
  - 预设色板：9 个基色，每个再生成 3 档浅色，共 36 色（[group.js L55-L81](https://github.com/node-red/node-red/blob/e4f7fc516cd8da1b4b4d571169cf6937b500bb30/packages/node_modules/@node-red/editor-client/src/js/ui/group.js#L55-L81)）。
  - 样式可以复制粘贴（Ctrl/⌘+Shift+C / V）。
- **缩小视图**：组没有专门的缩小处理。缩放比例 ≤0.75 和 ≤0.5 时只会加粗高亮描边（[view.js L7762-L7775](https://github.com/node-red/node-red/blob/e4f7fc516cd8da1b4b4d571169cf6937b500bb30/packages/node_modules/@node-red/editor-client/src/js/ui/view.js#L7762-L7775)）。
- **折叠**：没有。
- **成员关系**：显式记录。
  - 组节点有 `nodes` 成员列表，成员节点用 `g` 字段指向所属的组（[group.js L477-L522](https://github.com/node-red/node-red/blob/e4f7fc516cd8da1b4b4d571169cf6937b500bb30/packages/node_modules/@node-red/editor-client/src/js/ui/group.js#L477-L522)）。
  - 框的大小由成员算出，用户不能拖：取所有成员的外接矩形，每边加 26 的留白。标签太宽时会把框撑开。空组固定 40×40（[view.js L6589-L6650](https://github.com/node-red/node-red/blob/e4f7fc516cd8da1b4b4d571169cf6937b500bb30/packages/node_modules/@node-red/editor-client/src/js/ui/view.js#L6589-L6650)）。
- **交互**（[官方文档](https://nodered.org/docs/user-guide/editor/workspace/groups)、[view.js L2555-L2600](https://github.com/node-red/node-red/blob/e4f7fc516cd8da1b4b4d571169cf6937b500bb30/packages/node_modules/@node-red/editor-client/src/js/ui/view.js#L2555-L2600)）：
  - 选中节点后按 Ctrl/⌘+Shift+G 新建，Ctrl/⌘+Shift+U 解散，另有「合并选中项」。
  - 把节点拖到组上停一会儿就加入，按住 Alt 拖就移出。拖入时按鼠标所在的点判断落在哪个组，有重叠时取最里层的组（[view.js L5121-L5150](https://github.com/node-red/node-red/blob/e4f7fc516cd8da1b4b4d571169cf6937b500bb30/packages/node_modules/@node-red/editor-client/src/js/ui/view.js#L5121-L5150)）。
  - 支持嵌套。组里的节点只能拖进它所在组的子组。
- **自动布局**：Node-RED 没有自动布局。
- **运行状态**：没有。节点的变更标记和错误标记都排除了组（[view.js L1354](https://github.com/node-red/node-red/blob/e4f7fc516cd8da1b4b4d571169cf6937b500bb30/packages/node_modules/@node-red/editor-client/src/js/ui/view.js#L1354)）。
- **值得注意**：
  - 默认样式只有灰色描边，标签是角落里的小字，对画布干扰很小。
  - 框完全由成员算出，所以不会出现框和成员对不上的情况。
  - 组是一种新的节点类型。官方另发了一个什么都不做的占位模块 `node-red-node-group`，让旧版本也能导入带组的流程（[1.1 发版博客](https://nodered.org/blog/2020/06/30/version-1-1-released)）。

### 3.2 ComfyUI / LiteGraph group

版本：ComfyUI 新前端 `074f766`（发布版 v1.61.2 附近）；旧 LiteGraph（jagenjo/litegraph.js）`0555a2f`。

- **外观**（新前端，[LGraphGroup.ts L321-L380](https://github.com/Comfy-Org/ComfyUI_frontend/blob/074f7667aae87d63b80f12ec6b136b99845ead2a/src/lib/litegraph/src/LGraphGroup.ts#L321-L380)）：
  - 标题栏横跨整个框宽，高度等于节点标题高度 30。标题栏和框身都用组的颜色、25% 透明度填充，标题栏叠了两层，所以更深。
  - 描边和组同色、不透明。直角，右下角有一个边长 10 的三角形作为缩放手柄。
  - 标题 20 号 Inter 字体，左对齐，垂直居中在标题栏里（[LiteGraphGlobal.ts L85、L113-L114](https://github.com/Comfy-Org/ComfyUI_frontend/blob/074f7667aae87d63b80f12ec6b136b99845ead2a/src/lib/litegraph/src/LiteGraphGlobal.ts#L85)）。底色太暗时标题自动换成看得清的颜色。
  - 新建组默认用 pale_blue 色 `#3f789e`，最小 140×80（[LGraphGroup.ts L56-L60、L136-L137](https://github.com/Comfy-Org/ComfyUI_frontend/blob/074f7667aae87d63b80f12ec6b136b99845ead2a/src/lib/litegraph/src/LGraphGroup.ts#L56-L60)）。
  - 组画在背景层，在节点下面（[LGraphCanvas.ts L6829-L6853](https://github.com/Comfy-Org/ComfyUI_frontend/blob/074f7667aae87d63b80f12ec6b136b99845ead2a/src/lib/litegraph/src/LGraphCanvas.ts#L6829-L6853)）。
  - 右键菜单里有改字号的选项，但绘制时读的是全局的 `GROUP_TEXT_SIZE`，没有读组自己的 `font_size`，所以改字号实际不生效（这是读代码得出的，没有运行验证）。
- **说明文字**：组只存 `id、title、bounding、color、flags`，没有说明字段（[LGraphGroup.ts L305-L314](https://github.com/Comfy-Org/ComfyUI_frontend/blob/074f7667aae87d63b80f12ec6b136b99845ead2a/src/lib/litegraph/src/LGraphGroup.ts#L305-L314)）。说明要另放节点：
  - Note 是一个黄色节点，里面是一个多行文本框，属于不参与执行的「虚拟节点」。
  - MarkdownNote 同样是虚拟节点，内容按 Markdown 渲染。
  - 来源：[noteNode.ts L13-L81](https://github.com/Comfy-Org/ComfyUI_frontend/blob/074f7667aae87d63b80f12ec6b136b99845ead2a/src/extensions/core/noteNode.ts#L13-L81)，[Note 文档](https://docs.comfy.org/built-in-nodes/Note)，[MarkdownNote 文档](https://docs.comfy.org/built-in-nodes/MarkdownNote)。
- **颜色**：只能从预设色板里选，共 9 色（[LGraphCanvas.ts L574-L585](https://github.com/Comfy-Org/ComfyUI_frontend/blob/074f7667aae87d63b80f12ec6b136b99845ead2a/src/lib/litegraph/src/LGraphCanvas.ts#L574-L585)）：red `#A88`、brown `#b06634`、green `#8A8`、blue `#88A`、pale_blue `#3f789e`、cyan `#8AA`、purple `#a1309b`、yellow `#b58b2a`、black `#444`。
- **缩小视图**：节点在低缩放比例时会简化绘制，组没有这个分支，标题跟着等比变小（[LGraphCanvas.ts L782-L806](https://github.com/Comfy-Org/ComfyUI_frontend/blob/074f7667aae87d63b80f12ec6b136b99845ead2a/src/lib/litegraph/src/LGraphCanvas.ts#L782-L806)）。
- **折叠**：组不能折叠。替代做法是子图：选中节点后打包成一个可以复用的节点，双击进入，可以嵌套，也可以拆回原样，要求前端 1.24.3 及以上（[子图文档](https://docs.comfy.org/interface/features/subgraph)）。
- **成员关系**：按几何位置判断，成员关系不存盘（[LGraphGroup.ts L419-L466](https://github.com/Comfy-Org/ComfyUI_frontend/blob/074f7667aae87d63b80f12ec6b136b99845ead2a/src/lib/litegraph/src/LGraphGroup.ts#L419-L466)）。
  - 判定规则：节点外接矩形的中心点落在组里就算成员；另一个组必须整个被包住才算子组，并递归判定。
  - 什么时候重新判定：开始拖标题栏时，以及框选时（[LGraphCanvas.ts L2995-L3002](https://github.com/Comfy-Org/ComfyUI_frontend/blob/074f7667aae87d63b80f12ec6b136b99845ead2a/src/lib/litegraph/src/LGraphCanvas.ts#L2995-L3002)）。
  - 大小由用户拖右下角调整。另有「Fit Group To Contents」命令，一次性贴合成员（[useCoreCommands.ts L811-L823](https://github.com/Comfy-Org/ComfyUI_frontend/blob/074f7667aae87d63b80f12ec6b136b99845ead2a/src/composables/useCoreCommands.ts#L811-L823)）。
  - 旧 LiteGraph 的判定更宽松：节点外接矩形和组有任何重叠就算成员（[litegraph.js L5072-L5085](https://github.com/jagenjo/litegraph.js/blob/0555a2f2a3df5d4657593c6d45eb192359888195/src/litegraph.js#L5072-L5085)）。
- **交互**：
  - 选中节点后按 Ctrl+G 新建。新建的组贴合所选节点，四周留白默认 10（可以在设置里改成 0 到 100），新建后直接进入改标题的状态（[useCoreCommands.ts L630-L653](https://github.com/Comfy-Org/ComfyUI_frontend/blob/074f7667aae87d63b80f12ec6b136b99845ead2a/src/composables/useCoreCommands.ts#L630-L653)，[coreSettings.ts L380-L388](https://github.com/Comfy-Org/ComfyUI_frontend/blob/074f7667aae87d63b80f12ec6b136b99845ead2a/src/platform/settings/constants/coreSettings.ts#L380-L388)）。
  - 只有拖标题栏才会带着成员一起走。组可以钉住，钉住后不能移动、不能改大小。
- **自动布局、运行状态**：都查不到，组上没有执行状态汇总的代码。
- **值得注意**：
  - 新建时自动贴合，之后由用户自己调大小，需要时再执行「贴合内容」。这是把两件事分开来做。
  - 组和说明完全分开：说明要用单独的 Note 节点。

### 3.3 n8n：sticky note 和 Canvas Groups

版本：仓库 `2ca4d34`（发布版 n8n@2.47.7 附近）。n8n 现在有两套东西：sticky note 只管说明，Canvas Groups 是真正的分组。Canvas Groups 从 2.28.0 开始逐步开放，2.31.0 起所有实例都能用（[Canvas Groups 文档](https://docs.n8n.io/build/understand-workflows/workflow-components/canvas-groups)）。

**sticky note**

- **外观**：
  - 整块是一个圆角矩形，没有标题栏，有 1px 边框，边框比底色深一档（[Sticky.vue L152-L159](https://github.com/n8n-io/n8n/blob/2ca4d34615dff59312aca57fb998ab5f012cb965/packages/frontend/@n8n/design-system/src/components/N8nSticky/Sticky.vue#L152-L159)）。
  - 默认是浅黄底；深色主题换成暗黄（[_tokens.scss L95-L114](https://github.com/n8n-io/n8n/blob/2ca4d34615dff59312aca57fb998ab5f012cb965/packages/frontend/@n8n/design-system/src/css/_tokens.scss#L95-L114)）。
  - 默认大小 240×160（[StickyNote.node.ts L29-L45](https://github.com/n8n-io/n8n/blob/2ca4d34615dff59312aca57fb998ab5f012cb965/packages/nodes-base/nodes/StickyNote/StickyNote.node.ts#L29-L45)）。
  - 不在组里的便签层级是 -10100 起，在节点和连线下面（[canvasNodeGroups.constants.ts L15-L41](https://github.com/n8n-io/n8n/blob/2ca4d34615dff59312aca57fb998ab5f012cb965/packages/frontend/editor-ui/src/features/workflows/canvas/stores/canvasNodeGroups.constants.ts#L15-L41)）。
- **说明文字**：便签本身就是正文。
  - 用 Markdown 渲染，能嵌图片和 YouTube 视频。
  - 双击进入编辑，按 Esc 或点到别处退出（[官方文档](https://docs.n8n.io/workflows/components/sticky-notes/)，[Sticky.vue L103-L150](https://github.com/n8n-io/n8n/blob/2ca4d34615dff59312aca57fb998ab5f012cb965/packages/frontend/@n8n/design-system/src/components/N8nSticky/Sticky.vue#L103-L150)）。
- **颜色**：7 个预设色，另可选任意色，会记住最近用过的 8 个自定义色。用自定义色时，边框色和文字色按亮度自动算（[官方文档](https://docs.n8n.io/workflows/components/sticky-notes/)，[Sticky.vue L45-L63](https://github.com/n8n-io/n8n/blob/2ca4d34615dff59312aca57fb998ab5f012cb965/packages/frontend/@n8n/design-system/src/components/N8nSticky/Sticky.vue#L45-L63)）。
- **成员关系**：便签不记成员。官方文档的说法是「把便签拖到节点后面，在视觉上分组」。便签可以作为成员加入 Canvas Groups。

**Canvas Groups**

- **外观**：由标题栏和下面的框身两部分组成。
  - 标题栏的高度等于节点高度 96，底色是面板色，边框和节点用同一套（1.5px 实线），只有上边两角是圆角。
  - 标题栏里，名字用 md 字号、中等字重；描述用 sm 字号、淡一档的文字色（[CanvasNodeGroupTitleBar.vue L759-L800](https://github.com/n8n-io/n8n/blob/2ca4d34615dff59312aca57fb998ab5f012cb965/packages/frontend/editor-ui/src/features/workflows/canvas/components/elements/groups/CanvasNodeGroupTitleBar.vue#L759-L800)）。
  - 框身用悬停色填充，1.5px 虚线边框，没有上边框，下边两角是圆角（[L980-L997](https://github.com/n8n-io/n8n/blob/2ca4d34615dff59312aca57fb998ab5f012cb965/packages/frontend/editor-ui/src/features/workflows/canvas/components/elements/groups/CanvasNodeGroupTitleBar.vue#L980-L997)）。
  - 层级：展开的组是 -5000，在普通节点和连线下面；组里的便签在框身上面；折叠后的小块是 -1（[canvasNodeGroups.constants.ts L15-L41](https://github.com/n8n-io/n8n/blob/2ca4d34615dff59312aca57fb998ab5f012cb965/packages/frontend/editor-ui/src/features/workflows/canvas/stores/canvasNodeGroups.constants.ts#L15-L41)）。
- **说明文字**：组有一个可选的描述，最多 145 字，随工作流保存（[Canvas Groups 文档](https://docs.n8n.io/build/understand-workflows/workflow-components/canvas-groups)）。
  - 展开时，描述显示在名字下面一行。
  - 折叠时，名字旁边出现一个信息图标，悬停才能看到描述；点眼睛图标可以让描述一直显示。
  - 描述显示不显示、组折叠不折叠，都是个人偏好，存在浏览器里，不进工作流。
- **颜色**：没有。组的数据只有 `id、name、nodeIds、description` 四个字段（[interfaces.ts L3831-L3836](https://github.com/n8n-io/n8n/blob/2ca4d34615dff59312aca57fb998ab5f012cb965/packages/workflow/src/interfaces.ts#L3831-L3836)）。
- **缩小视图**：缩放比例低于 0.66 时，所有描述和描述的图标都隐藏（[canvasNodeGroups.constants.ts L12-L13](https://github.com/n8n-io/n8n/blob/2ca4d34615dff59312aca57fb998ab5f012cb965/packages/frontend/editor-ui/src/features/workflows/canvas/stores/canvasNodeGroups.constants.ts#L12-L13)）。标题不放大。
- **折叠**：点标题栏就能折叠或展开。
  - 折叠后成员隐藏，组变成 400 宽的小块。
  - 快捷键 Alt+G 展开、Shift+Alt+G 折叠，作用于选中的组；什么都没选时作用于全部组。
  - 只读视图默认全部展开。
- **成员关系**：显式记录，用 `nodeIds` 列表。
  - 框的大小完全由成员外接矩形算出：左右各留 56，上面留 40 再加上标题栏，下面留 88，宽度至少 400（[useCanvasMapping.groups.ts L72-L87](https://github.com/n8n-io/n8n/blob/2ca4d34615dff59312aca57fb998ab5f012cb965/packages/frontend/editor-ui/src/features/workflows/canvas/composables/useCanvasMapping.groups.ts#L72-L87)，[canvasNodeGroups.constants.ts L3-L9](https://github.com/n8n-io/n8n/blob/2ca4d34615dff59312aca57fb998ab5f012cb965/packages/frontend/editor-ui/src/features/workflows/canvas/stores/canvasNodeGroups.constants.ts#L3-L9)）。
  - 约束很严（[Canvas Groups 文档](https://docs.n8n.io/build/understand-workflows/workflow-components/canvas-groups)）：
    - 不能包含触发器。
    - 节点不能已经在别的组里，所以组也不能嵌套。
    - 成员必须连成一条链，组外的节点只能连到组的第一个或最后一个节点。
    - AI 节点和它的子节点必须在同一个组里。
    - 至少 2 个成员。
  - 保存时如果发现组不合规，会自动解散，并给出警告。
- **交互**：
  - 选中节点后按 Ctrl/⌘+G、点工具栏图标或用右键菜单新建；Ctrl/⌘+Shift+G 解散；按空格改名。
  - 拖标题栏时，组里的节点一起走；单独拖一个成员时，标题栏跟着那个节点的位置更新（[useCanvasNodeGroupDrag.ts L34-L37](https://github.com/n8n-io/n8n/blob/2ca4d34615dff59312aca57fb998ab5f012cb965/packages/frontend/editor-ui/src/features/workflows/canvas/composables/useCanvasNodeGroupDrag.ts#L34-L37)）。
  - 文档没写怎样把单个节点拖进或拖出组。
- **自动布局**：整理布局（tidy up，用 dagre）时，先单独排组里的成员，再把整组当成一个盒子参与排版（折叠的组按小块算，展开的组按框身算）。盖在组上的便签跟着组一起走（[useCanvasLayout.ts L184-L232](https://github.com/n8n-io/n8n/blob/2ca4d34615dff59312aca57fb998ab5f012cb965/packages/frontend/editor-ui/src/features/workflows/canvas/composables/useCanvasLayout.ts#L184-L232)）。
- **运行状态**：只在折叠时，在小块的边框和图标上显示汇总状态；展开时由成员节点自己显示（[useCanvasMapping.groups.ts L155-L200](https://github.com/n8n-io/n8n/blob/2ca4d34615dff59312aca57fb998ab5f012cb965/packages/frontend/editor-ui/src/features/workflows/canvas/composables/useCanvasMapping.groups.ts#L155-L200)）。
  - 汇总规则：优先级是 waiting > running > error > issues > warning。
  - 空闲状态既不改颜色，也不影响结果。
  - 只有所有成员都成功，才显示 success。
- **值得注意**：
  - 「说明」和「分组」是两套机制：便签只管说明，组只管分组。
  - 组的汇总状态只在折叠时显示，这样不会和成员节点的状态重复。

### 3.4 Dify note

版本：仓库 `0ba3c9d`（发布版 1.19.0 附近）。docs.dify.ai 上没有专门介绍 note 的页面。

- **外观**：
  - 注释节点是独立的便签节点（类型 `custom-note`），不是分组框。
  - 圆角约 6，有细边框和小阴影，底色用所选颜色的 50 档；选中时边框换成该颜色的 300 档。
  - 顶部有一条 8px 高的色条，透明度 50%；色条不放文字，所以没有标题（[note-node/index.tsx L45-L48](https://github.com/langgenius/dify/blob/0ba3c9d76887b6c89c943abaab87f8d86c27d612/web/app/components/workflow/note-node/index.tsx#L45-L48)）。
  - 正文段落 12px（[theme.css L1-L3](https://github.com/langgenius/dify/blob/0ba3c9d76887b6c89c943abaab87f8d86c27d612/web/app/components/workflow/note-node/note-editor/theme/theme.css#L1-L3)）。
- **说明文字**：正文直接写在便签里，用 Lexical 富文本编辑器（[toolbar/index.tsx L21-L45](https://github.com/langgenius/dify/blob/0ba3c9d76887b6c89c943abaab87f8d86c27d612/web/app/components/workflow/note-node/note-editor/toolbar/index.tsx#L21-L45)）。
  - 支持的格式：字号、粗体、斜体、删除线、链接、列表。
  - 存的是编辑器状态的 JSON，不是 Markdown。
  - 可以在底部显示作者名。
- **颜色**：只能从 6 个预设里选：blue、cyan、green、yellow、pink、violet。新建时默认 blue（[constants.ts L6-L46](https://github.com/langgenius/dify/blob/0ba3c9d76887b6c89c943abaab87f8d86c27d612/web/app/components/workflow/note-node/constants.ts#L6-L46)，[operator/hooks.ts L24-L33](https://github.com/langgenius/dify/blob/0ba3c9d76887b6c89c943abaab87f8d86c27d612/web/app/components/workflow/operator/hooks.ts#L24-L33)）。
- **缩小视图、折叠**：都没有。
- **成员关系**：没有成员。凡是判断能不能连线、能不能放进迭代容器的地方，都把便签排除在外（[use-workflow.ts L373](https://github.com/langgenius/dify/blob/0ba3c9d76887b6c89c943abaab87f8d86c27d612/web/app/components/workflow/hooks/use-workflow.ts#L373)）。
  - 大小由用户拖控制柄调，最小 240×88（[index.tsx L62-L68](https://github.com/langgenius/dify/blob/0ba3c9d76887b6c89c943abaab87f8d86c27d612/web/app/components/workflow/note-node/index.tsx#L62-L68)）。
- **自动布局**：ELK 整理布局只处理普通节点，便签不动（[elk-layout.ts L456](https://github.com/langgenius/dify/blob/0ba3c9d76887b6c89c943abaab87f8d86c27d612/web/app/components/workflow/utils/elk-layout.ts#L456)）。
- **分组**：Dify 没有分组功能，节点类型里没有 group（[types.ts L30-L67](https://github.com/langgenius/dify/blob/0ba3c9d76887b6c89c943abaab87f8d86c27d612/web/app/components/workflow/types.ts#L30-L67)）。
  - 迭代和循环容器属于执行结构，不是注释。
  - 外观是大圆角的画布色底，里面再铺一层点阵（[iteration/node.tsx L33-L41](https://github.com/langgenius/dify/blob/0ba3c9d76887b6c89c943abaab87f8d86c27d612/web/app/components/workflow/nodes/iteration/node.tsx#L33-L41)）。
  - 子节点超出容器时，容器自动变大，但不会缩小（[use-interactions.helpers.ts L30-L58](https://github.com/langgenius/dify/blob/0ba3c9d76887b6c89c943abaab87f8d86c27d612/web/app/components/workflow/nodes/iteration/use-interactions.helpers.ts#L30-L58)）。

### 3.5 Langflow note

版本：仓库 `86fde09`（v1.13.2 附近）。docs.langflow.org 上没有专门介绍 note 的页面。

- **外观**：没有标题栏（[NoteNode/index.tsx L187-L192](https://github.com/langflow-ai/langflow/blob/86fde091f88a8b40507512d36ed78b5917dc165e/src/frontend/src/CustomNodes/NoteNode/index.tsx#L187-L192)）。
  - 圆角约 12。
  - 未选中时便签沉到其他节点下面（`-z-50`），选中后浮上来。
  - 正文 16px、中等字重，比普通节点的描述（12px）大。
  - 用自定义色时，按底色亮度自动选黑字或白字。
- **说明文字**：正文直接显示在便签里，用 `react-markdown` 渲染，最多 2500 字（[NoteNode/index.tsx L19](https://github.com/langflow-ai/langflow/blob/86fde091f88a8b40507512d36ed78b5917dc165e/src/frontend/src/CustomNodes/NoteNode/index.tsx#L19)）。
- **颜色**：5 个预设色（amber、neutral、rose、blue、lime），加一个「透明」，另有取色器可以选任意色。选「透明」时没有底色和边框，文字直接浮在画布上（[constants.ts L921-L928](https://github.com/langflow-ai/langflow/blob/86fde091f88a8b40507512d36ed78b5917dc165e/src/frontend/src/constants/constants.ts#L921-L928)，[color-picker-buttons.tsx L9-L40](https://github.com/langflow-ai/langflow/blob/86fde091f88a8b40507512d36ed78b5917dc165e/src/frontend/src/CustomNodes/NoteNode/components/color-picker-buttons.tsx#L9-L40)）。
- **成员关系**：没有成员。大小由用户调，最小 280×140（[constants.ts L907-L909](https://github.com/langflow-ai/langflow/blob/86fde091f88a8b40507512d36ed78b5917dc165e/src/frontend/src/constants/constants.ts#L907-L909)）。
- **缩小视图、折叠、自动布局**：都查不到相关处理。
- **Group**：这个功能还在，但它不是框。
  - 用法：选中多个组件，点浮出来的 Group 按钮，它们就合成一个组件；之后可以 Ungroup 拆开（[Components 文档](https://docs.langflow.org/concepts-components)，[SelectionMenuComponent L77-L113](https://github.com/langflow-ai/langflow/blob/86fde091f88a8b40507512d36ed78b5917dc165e/src/frontend/src/pages/FlowPage/components/SelectionMenuComponent/index.tsx#L77-L113)）。
  - 合并后的组件里存着一份子流程，外部连线改连到这个组件上（[reactflowUtils.ts L1558-L1580](https://github.com/langflow-ai/langflow/blob/86fde091f88a8b40507512d36ed78b5917dc165e/src/frontend/src/utils/reactflowUtils.ts#L1558-L1580)）。

### 3.6 Apache Airflow TaskGroup（Graph 视图）

版本：Airflow 3 仓库 `715043b`（3.4.0 附近）；Airflow 2 标签 2.11.0。两代 Graph 视图都用 React Flow 加 elkjs 实现。

- **定位**：官方文档说 TaskGroup 用来在 Graph 视图里把任务分层，减少视觉杂乱（[dags.rst L556-L563](https://github.com/apache/airflow/blob/715043b898089c40053108246a0e549f9c16c982/airflow-core/docs/core-concepts/dags.rst#L556-L563)）。
- **外观**（3.x，[TaskNode.tsx L109-L148](https://github.com/apache/airflow/blob/715043b898089c40053108246a0e549f9c16c982/airflow-core/src/airflow/ui/src/components/Graph/TaskNode.tsx#L109-L148)）：
  - 组和任务用同一个卡片组件画，圆角 5，边框 2（选中时 4）。
  - 组的第一行是组图标加组名，下一行是小字「Task Group」。
  - 展开时，这张卡片被拉大，把子任务包在里面，没有单独的标题栏。
  - 边框颜色：选中时是蓝色；没选中时用组的汇总状态色；没有状态就用普通边框色。
  - 没设颜色时，展开的组按嵌套层数交替深浅（偶数层用 `bg.muted`）。
- **说明文字**：
  - `tooltip` 是悬停在组节点上时显示的提示。
  - `doc_md` 按 Markdown 渲染，显示在详情面板里，不画在图上（[dags.rst L731-L749](https://github.com/apache/airflow/blob/715043b898089c40053108246a0e549f9c16c982/airflow-core/docs/core-concepts/dags.rst#L731-L749)，[taskgroup.py L116-L124](https://github.com/apache/airflow/blob/715043b898089c40053108246a0e549f9c16c982/task-sdk/src/airflow/sdk/definitions/taskgroup.py#L116-L124)）。
- **颜色**：在代码里给 `ui_color` 和 `ui_fgcolor` 设任意色，默认分别是 `CornflowerBlue` 和 `#000`（[taskgroup.py L154-L161](https://github.com/apache/airflow/blob/715043b898089c40053108246a0e549f9c16c982/task-sdk/src/airflow/sdk/definitions/taskgroup.py#L154-L161)）。
  - 3.x 不拿这个颜色整块涂满，而是和背景色混合：展开且在偶数层时取 45%，其他情况取 22%。
- **缩小视图**：
  - 3.x 没有缩小时隐藏细节的处理（[Graph.tsx L196-L211](https://github.com/apache/airflow/blob/715043b898089c40053108246a0e549f9c16c982/airflow-core/src/airflow/ui/src/layouts/Details/Graph/Graph.tsx#L196-L211)）。
  - 2.x 在缩放比例低于 0.5 时隐藏状态文字和算子名，边框加粗到 6，圆角从 5 变成 10（[DagNode.tsx L105-L136](https://github.com/apache/airflow/blob/d9ed7b94d033dc61ee1c05aafb9f1c1f7b82cfb2/airflow/www/static/js/dag/details/graph/DagNode.tsx#L105-L136)）。
- **折叠**：点组右上角的「+ N tasks / - N tasks」按钮展开或收起。默认展开还是收起由用户设置决定，哪些组已展开按 DAG 记在浏览器里（[GroupsProvider.tsx L38-L113](https://github.com/apache/airflow/blob/715043b898089c40053108246a0e549f9c16c982/airflow-core/src/airflow/ui/src/context/groups/GroupsProvider.tsx#L38-L113)）。
  - 收起后是一张卡片，下面叠两条逐渐变窄的小条，看起来像一摞卡片。
  - 卡片里有一条 6px 高的分段状态条，按子任务各状态的数量分段上色（[TaskNode.tsx L198-L245](https://github.com/apache/airflow/blob/715043b898089c40053108246a0e549f9c16c982/airflow-core/src/airflow/ui/src/components/Graph/TaskNode.tsx#L198-L245)，[SegmentedStateBar.tsx L29-L48](https://github.com/apache/airflow/blob/715043b898089c40053108246a0e549f9c16c982/airflow-core/src/airflow/ui/src/components/Graph/SegmentedStateBar.tsx#L29-L48)）。
- **成员关系**：显式记录。DAG 代码里写在 `with TaskGroup(...)` 下面的任务就是成员，后端据此生成嵌套的 `children`（[task_group.py L88-L115](https://github.com/apache/airflow/blob/715043b898089c40053108246a0e549f9c16c982/airflow-core/src/airflow/api_fastapi/core_api/services/ui/task_group.py#L88-L115)）。
  - 组的大小由 ELK 算出，节点不能拖。
  - 展开的组内边距：上 80（留给组标题），左、右、下各 15（[elkGraphUtils.ts L356-L359](https://github.com/apache/airflow/blob/715043b898089c40053108246a0e549f9c16c982/airflow-core/src/airflow/ui/src/components/Graph/elkGraphUtils.ts#L356-L359)）。
- **交互**：只能展开、收起和选中。不能在界面上新建组或改大小。
- **自动布局**：组在 ELK 里是层级节点，设置 `hierarchyHandling: "INCLUDE_CHILDREN"`（[elkGraphUtils.ts L291-L436](https://github.com/apache/airflow/blob/715043b898089c40053108246a0e549f9c16c982/airflow-core/src/airflow/ui/src/components/Graph/elkGraphUtils.ts#L291-L436)）。
  - 收起的组当一个节点来排，宽至少 200，高 80，有分段条时高 90；跨组的连线改成连到组上。
  - 展开的组里，如果所有对外有连线的子任务，上游和下游完全一样，就把多条穿过组边界的连线合成一条组级连线。
- **运行状态汇总**：由后端算好再发给前端（[grid.py L170-L260](https://github.com/apache/airflow/blob/715043b898089c40053108246a0e549f9c16c982/airflow-core/src/airflow/api_fastapi/core_api/services/ui/grid.py#L170-L260)）。
  - 后端按优先级取子任务里排得最靠前的状态（[misc.py L142-L157](https://github.com/apache/airflow/blob/715043b898089c40053108246a0e549f9c16c982/airflow-core/src/airflow/api_fastapi/common/parameters/misc.py#L142-L157)）。顺序是：
    - 失败类：failed、upstream_failed。
    - 重试和重新调度：up_for_retry、up_for_reschedule。
    - 正在跑或等着跑：running、restarting、deferred、awaiting_input、queued、scheduled。
    - 没有状态：None。
    - 已结束：success、skipped、removed。
  - 意思是：有失败就显示失败，全部成功才显示成功。
  - 前端把汇总状态画在三处：边框色、徽章，收起时再加分段条（[TaskNode.tsx L191-L217](https://github.com/apache/airflow/blob/715043b898089c40053108246a0e549f9c16c982/airflow-core/src/airflow/ui/src/components/Graph/TaskNode.tsx#L191-L217)）。
- **值得注意**：
  - 汇总状态由后端按固定优先级算好，前端不自己合并。
  - 收起后用分段条显示各状态的数量，比单个状态带的信息多。
  - 嵌套的组靠交替深浅来区分，不用新颜色。

### 3.7 React Flow（@xyflow/react）sub flows / group 节点

版本：xyflow 仓库 `8256e52`（@xyflow/react 13.0.1）。sfly 的画布就是用这个库做的，这里作为补充。

- **外观**：内置的 group 节点只是一个半透明矩形，没有标题栏。
  - 基础样式：背景 `rgba(240,240,240,0.25)`，1px 边框，圆角 3（[style.css L46-L74](https://github.com/xyflow/xyflow/blob/8256e52e2c7e9ba270784395817822520a660da1/packages/system/src/styles/style.css#L46-L74)）。
  - 官方主题：深色模式下背景 `rgba(123,107,148,0.22)`，边框 `#7b6b94`，圆角 8（[xy-theme.css L112-L115](https://github.com/xyflow/xyflow/blob/8256e52e2c7e9ba270784395817822520a660da1/packages/system/src/styles/xy-theme.css#L112-L115)）。
- **成员关系**：显式记录（[Sub Flows 指南](https://reactflow.dev/learn/layouting/sub-flows)，[types/nodes.ts L52-L64](https://github.com/xyflow/xyflow/blob/8256e52e2c7e9ba270784395817822520a660da1/packages/system/src/types/nodes.ts#L52-L64)）。
  - 子节点的 `parentId` 指向父节点，坐标相对父节点的左上角，父节点移动时子节点跟着走。
  - `extent: 'parent'` 让子节点拖不出父节点。
  - `expandParent: true` 让子节点拖到边缘时，父节点自动变大，但不会自动缩小。
  - 任何类型的节点都能当父节点，`group` 只是一个没有连接点的现成类型。
- **改大小**：`NodeResizer` 提供缩放控制柄。缩放时会考虑 `extent` 和 `expandParent`，父节点最小只能缩到刚好包住子节点（[XYResizer.ts L184-L215](https://github.com/xyflow/xyflow/blob/8256e52e2c7e9ba270784395817822520a660da1/packages/system/src/xyresizer/XYResizer.ts#L184-L215)，[NodeResizer 文档](https://reactflow.dev/api-reference/components/node-resizer)）。
- **折叠**：库里没有。官方示例是把子节点设成 `hidden`（[Subflow 示例 L219](https://github.com/xyflow/xyflow/blob/8256e52e2c7e9ba270784395817822520a660da1/examples/react/src/examples/Subflow/index.tsx#L219)）。
- **层级**：`zIndexMode` 默认是 `auto`，库会自动处理选中节点和子流程的层级（[general.ts L385-L393](https://github.com/xyflow/xyflow/blob/8256e52e2c7e9ba270784395817822520a660da1/packages/system/src/types/general.ts#L385-L393)）。
- **自动布局**：官方布局概览页比较了几种布局库（[Layouting 概览](https://reactflow.dev/learn/layouting/layouting)）。
  - Dagre 支持子流程，但有已知问题：子流程里的节点连到子流程外面时会排错。
  - d3-hierarchy 和 d3-force 不支持子流程。
  - ELK 支持子流程。
  - 免费的 elkjs 示例没有用到 `parentId`。Airflow 3 的做法是一个可以参考的实例：先建 ELK 层级图，再换算成 React Flow 的父子坐标，见 §3.6。
- **值得注意**：标题、说明、折叠、汇总这些都要应用自己做。sfly 现在不用 `parentId`，而是自己算框的范围，这和 Airflow 的做法（框由布局结果决定）更接近。

### 3.8 Unreal Engine Blueprint comment box

版本：UE 5.9 文档。UE 源码要登录 Epic 账号才能看，这里只用了官方文档。

- **外观**：框有一条标题栏，标题写在里面。背景色由 `Comment Color` 决定，官方提醒用透明度调背景（[Comments 文档](https://dev.epicgames.com/documentation/en-us/unreal-engine/comments-in-unreal-engine)）。
  - 圆角、边框、默认字号、层级，文档里都没写。
- **说明文字**：注释框只有标题。另有一种「节点注释」，是挂在单个节点上的气泡，和注释框是两套东西。
- **颜色**：在 Details 面板里用取色器选任意色，可以带透明度。
  - 文档还列了一个 `Color Comment Bubble` 选项，说明是勾选后会把 Comment Color 用到注释框上。
- **缩小视图**：文档原文：「The text of comment boxes will scale as the graph is zoomed」，节点注释则不随缩放变化。官方把注释框当作缩小后看全图的工具。
  - API 参考页里据说还有 `Show Bubble When Zoomed`，作用是缩小时显示一个不随缩放变小的气泡。但这个页面打不开（会跳回文档首页），这一条只见于搜索摘要，**未核实**。
- **成员关系**：按几何位置判断。默认情况下，框的边界里面的节点会跟着框一起移动。
  - 每个框可以设 `Move Mode`：`Group Movement` 是连节点一起移，`Comment` 是只移框。
  - 大小由用户拖右下角调。
- **交互**：
  - 选中节点后右键选「Create Comment from Selection」，或者按 C 新建；双击标题栏或按 F2 改标题。
  - 删框不影响里面的节点。
  - 材质编辑器的文档明确说注释框可以嵌套（[Organizing a Material Graph](https://dev.epicgames.com/documentation/en-us/unreal-engine/organizing-a-material-graph-in-unreal-engine)）。
- **折叠、自动布局、运行状态**：文档没提到。
- **值得注意**：
  - 「移动时带不带成员」是每个框各自的开关。
  - 注释分两层：注释框说明一片区域，气泡说明单个节点。

### 3.9 Blender 节点编辑器 frame

版本：源码标签 `v4.5.0`，手册 blender-v4.5-release 分支。

- **外观**（[node_draw.cc L4358-L4425](https://github.com/blender/blender/blob/v4.5.0/source/blender/editors/space_node/node_draw.cc#L4358-L4425)）：
  - frame 是一块圆角填充矩形，没有标题栏，也没有分隔线。
  - 默认主题下 frame 底色是 `#0f0f0f`、80% 不透明（主题字段 `movie`），节点编辑器背景是 `#1d1d1d`。也就是说，frame 比画布暗一档、接近不透明，这和 sfly 的「暗井」几乎一样（[userdef_default_theme.c L844、L905](https://github.com/blender/blender/blob/v4.5.0/release/datafiles/userdef/userdef_default_theme.c#L905)，[resources.cc L673-L675](https://github.com/blender/blender/blob/v4.5.0/source/blender/editors/interface/resources.cc#L673-L675)）。
  - 平时不描边，只有选中时、或者拖节点悬停到它上面时才描边。
  - 嵌套的 frame 按层数奇偶交替：奇数层比偶数层亮 20。
  - 圆角是 0.2 个界面单位（[node_intern.hh L132](https://github.com/blender/blender/blob/v4.5.0/source/blender/editors/space_node/node_intern.hh#L132)）。
  - frame 背景在所有节点之前画，所以在节点下面（[node_draw.cc L4917](https://github.com/blender/blender/blob/v4.5.0/source/blender/editors/space_node/node_draw.cc#L4917)）。
- **标题**（[node_draw.cc L4284-L4356](https://github.com/blender/blender/blob/v4.5.0/source/blender/editors/space_node/node_draw.cc#L4284-L4356)，[node_common.cc L520-L522](https://github.com/blender/blender/blob/v4.5.0/source/blender/nodes/intern/node_common.cc#L520-L522)）：
  - 标题用节点的 label，水平居中写在框顶。
  - 默认字号 `label_size = 20`，乘以界面缩放。
  - 有标题时，顶部留出约 1.5 倍字高的空白，其余三边留 1.5 个界面单位（[node_draw.cc L4108-L4150](https://github.com/blender/blender/blob/v4.5.0/source/blender/editors/space_node/node_draw.cc#L4108-L4150)）。
- **说明文字**：frame 可以挂一个文本数据块，正文直接画在框里（同一段代码）。
  - 正文和标题字号相同，按框宽自动换行，超出框底就截断。
  - 正文只读，要到文本编辑器里改。
  - 手册原文是「frame nodes can display the contents of a text data-block. This is read-only」（[Frame 手册](https://projects.blender.org/blender/blender-manual/raw/branch/blender-v4.5-release/manual/interface/controls/nodes/frame.rst)）。
- **颜色**：默认用主题色；也可以给单个 frame 设自定义色，但透明度仍取主题的值。
- **缩小视图**：没有专门处理，标题跟着视图缩放。
- **折叠**：没有。
- **成员关系**：显式父子关系。节点的 `parent` 指向它所在的 frame。
  - Shrink 默认开着：frame 的范围由子节点的外接矩形算出，每次绘制都重新算（[node_draw.cc L4196-L4215](https://github.com/blender/blender/blob/v4.5.0/source/blender/editors/space_node/node_draw.cc#L4196-L4215)）。
  - 关掉 Shrink 后可以手动调大小（[transform_convert_node.cc L101-L124](https://github.com/blender/blender/blob/v4.5.0/source/blender/editors/transform/transform_convert_node.cc#L101-L124)）。
- **交互**（[编辑手册](https://projects.blender.org/blender/blender-manual/raw/branch/blender-v4.5-release/manual/interface/controls/nodes/editing.rst)，[node_relationships.cc L2106-L2143](https://github.com/blender/blender/blob/v4.5.0/source/blender/editors/space_node/node_relationships.cc#L2106-L2143)）：
  - 选中节点后按 F 新建。
  - 把节点拖到 frame 上松手就加入，按鼠标所在位置找最上层的 frame。
  - 拖动的过程中按 F，可以在「脱离当前 frame」和「加入光标下的 frame」之间切换。
  - 不能把父 frame 拖进它自己的子 frame。
  - 移动 frame 时，里面的节点跟着走。
- **自动布局**：没有自动布局，只有 Auto-Offset：把节点放到连线上时，会把相邻节点挪开（[Arranging 手册](https://projects.blender.org/blender/blender-manual/raw/branch/blender-v4.5-release/manual/interface/controls/nodes/arranging.rst)）。
- **运行状态**：frame 显示子节点执行时间之和，嵌套的 frame 递归求和，Geometry Nodes 和 Compositor 都是这样（[node_draw.cc L2825-L2840、L2874-L2906](https://github.com/blender/blender/blob/v4.5.0/source/blender/editors/space_node/node_draw.cc#L2825-L2840)）。
- **值得注意**：底色很暗、接近不透明的框，只要标题不做成一块底，就不会被看成节点。这一点对 sfly 最直接。

### 3.10 Nuke Backdrop 节点

版本：Nuke 17.1v3 用户指南；Python API 文档是 14.0 版。

- **外观**：Backdrop 是放在节点后面的一个框。标题栏可以拖，右下角有一个三角用来缩放；用 `Z Order` 控制前后，数值越小越靠后（[Backdrop 参考](https://learn.foundry.com/nuke/content/reference_guide/other_nodes/backdrop.html)，[Grouping Nodes](https://learn.foundry.com/nuke/content/comp_environment/organizing_scripts/grouping_nodes.html)）。
  - 默认颜色、圆角、字号，官方文档没写。
- **说明文字**：只有标题（label）。
- **颜色**：用取色器选任意色。`appearance` 设为 Border 时不填充、只画边框，文档说这样在暗光环境下更不累眼睛。
- **成员关系**：按几何位置判断。移动框时，「all the nodes that overlap the box are moved, too」。Python API 的 `getNodes()` 返回框里的节点（[nuke.BackdropNode](https://learn.foundry.com/nuke/developers/140/pythonreference/_autosummary/nuke.BackdropNode.html)）。大小由用户调。
- **交互**：从菜单 Other > Backdrop 新建。删除有三种方式：
  - 点标题栏后按 Delete，框和里面的节点都删掉。
  - 按住 Ctrl/⌘ 点标题栏再按 Delete，只删框。
  - 点右下角三角再按 Delete，只删节点、保留框。
- **书签**：Backdrop 默认是书签，可以按 J 跳过去（[Navigating the Node Graph](https://learn.foundry.com/nuke/content/getting_started/using_interface/navigating_node_graph.html)，这条内容来自搜索摘要）。
- **缩小视图、折叠、嵌套、自动布局、运行状态**：官方文档都没写。
- 属性名 `note_font_size`、`bdwidth`、`bdheight` 等只在第三方代码里见到（**二手**：[charlesangus/anchors](https://github.com/charlesangus/anchors)）。

### 3.11 Houdini network box 和 sticky note

版本：sidefx.com 当前版文档（页面没有标版本号）。

- **network box**：
  - **外观**：顶栏写标题。透明度默认跟随界面配置，也可以给单个框单独设置（[hou.NetworkBox](https://www.sidefx.com/docs/houdini/hom/hou/NetworkBox.html)）。圆角、边框、字号，文档没写。
  - **说明文字**：顶栏里显示的是框的 comment，没有正文（[Organizing networks](https://www.sidefx.com/docs/houdini/network/organize.html)）。
  - **颜色**：用颜色面板选，选中框后点色块，或者把颜色拖到框上；色板可以增删。
  - **折叠**：点减号按钮，框收成只剩顶栏。按住 Ctrl 再点，编辑器会挪开周围的节点。
  - **成员关系**：显式记录。用 `addItem`、`removeItem` 增删成员，用 `items(recurse)` 取成员，可以递归到嵌套的框里（[hou.NetworkBox](https://www.sidefx.com/docs/houdini/hom/hou/NetworkBox.html)）。
    - `autoFit` 默认是 False：成员被拖出框边时，框不会自己变大。无论这个开关怎么设，编辑器画框时都会包住全部内容。
    - 要贴合可以用 `fitAroundContents()`，或者菜单里的 Shift+M「Resize network boxes to fit」。
  - **交互**（[Organizing networks](https://www.sidefx.com/docs/houdini/network/organize.html)）：
    - 新建：Shift+O 把选中项放进一个新框。
    - 拖顶栏，整组一起移动。
    - 把节点慢慢拖向框边，框会变大；快速拖出去，节点就脱离框。
    - 拖角改大小。
    - 可以嵌套，框里还可以放 sticky note 和图片。
    - 删除：Delete 只删框，「Delete with network box contents」连内容一起删。
- **sticky note**（[hou.StickyNote](https://www.sidefx.com/docs/houdini/hom/hou/StickyNote.html)）：
  - 有颜色背景和顶栏，正文点一下就能编辑，纯文本。
  - 背景色和文字色分开设。可以关掉背景，变成画布上浮着的一段文字。
  - 字号有几档可选。官方建议设成大号，「makes the labels visible at far zoom」。
  - 可以折叠成只剩顶栏，也可以放进 network box。
- **节点 comment**：每个节点有一段 comment，打开「Show comment in network」后会显示在节点旁边。
- **自动布局、运行状态**：文档没写。
- **值得注意**：
  - 分组和说明分开：network box 只放标题，说明交给 sticky note。
  - 用拖动的速度区分「把框撑大」和「拖出框外」。

### 3.12 TouchDesigner Annotate

版本：docs.derivative.ca 当前页。

- **三种模式**：同一个 Annotate COMP 有三种模式（[Annotate COMP](https://docs.derivative.ca/Annotate_COMP)）：
  - Comment：只有正文，没有标题栏。
  - Network Box：有标题栏。
  - Annotate：标题、正文和其他功能都有。
- **外观**：
  - 标题栏高度可以设（`Titleheight`），标题字自动撑满标题栏，可以左、中、右对齐。
  - 层级分三档：默认在网格下面，也可以放在网格和节点之间，或者放在节点上面。小框被大框包住时，小框显示在前面。
  - 圆角、边框、默认字号，文档没写。
- **说明文字**：Annotate 模式有标题和正文。
  - 正文的字号、最大宽度、是否自动换行都可以设，纯文本。
  - 框里还可以嵌入一个算子的实时画面（OP Viewer）。
- **颜色**：背景色（RGB）可以任意设，再加背景透明度和整体透明度。
- **成员关系**：按几何位置判断。开了 `encloseops` 后，框范围内的算子（包括别的 Annotate）会跟着框一起移动。没有成员列表。
- **交互**（[Comments, Network Boxes, Annotates](https://docs.derivative.ca/Network_Utilities:_Comments,_Network_Boxes,_Annotates)）：
  - 新建：Shift+C（Comment）、Shift+B（Network Box）、Shift+A（Annotate），也可以用右键菜单。
  - 拖标题栏，整组一起移动；按住 Alt 拖，只移框。
  - 拖边改大小。Network Box 模式下，把节点拖到框边上，框会自己变大包住它。
  - 只有标题栏和边能点；点正文区等于点下面的网络，所以框里的节点总能直接点到。
  - 可以锁定。
- **缩小视图、折叠、自动布局、运行状态**：文档没写。
- **值得注意**：
  - 三种形态做成了同一个组件的三个模式。
  - 正文区点击会穿透到下面，框不会挡住里面的节点。

### 3.13 Figma / FigJam section

访问日期 2026-11-17。帮助中心页面用抓取工具读取，读到的是摘要，不是逐字原文。

- **外观**：
  - section 的标题可以在画布上直接双击改；背景和边框由右侧栏的 Fill 和 Stroke 控制（[Organize your canvas with sections](https://help.figma.com/hc/en-us/articles/9771500257687-Organize-your-canvas-with-sections)）。
  - 插件 API 的 SectionNode 有 `fills`、`strokes`、`cornerRadius` 等属性（[SectionNode](https://developers.figma.com/docs/plugins/api/SectionNode/)）。
  - 名字牌的样式和位置，官方文档没写。
- **说明文字**：section 只有名字。
  - Figma 官方的 MCP 指南建议：名字只写简短的导航标识，可见的说明性标题另放一个文本节点在 section 里（[create-section.md](https://github.com/figma/mcp-server-guide/blob/490a73c7537123cb1f0bcaced658585f0ee32fd9/skills/figma-use-figjam/references/create-section.md)）。
  - FigJam 的 sticky 是独立便签：可以改字号、加粗、用列表，支持 Markdown 写法，默认在底部显示作者（[Sticky notes in FigJam](https://help.figma.com/hc/en-us/articles/1500004414322-Sticky-notes-in-FigJam)）。
- **颜色**：
  - FigJam 的 section 和形状、连线共用一套预设色，深浅成对，约 18 色，另外可以输入任意色（[Apply colors in FigJam](https://help.figma.com/hc/en-us/articles/1500004291341-Apply-colors-in-FigJam)）。
  - 官方 MCP 指南里另有一组更浅的 10 色 section 背景色（[figjam-colors.md](https://github.com/figma/mcp-server-guide/blob/490a73c7537123cb1f0bcaced658585f0ee32fd9/skills/figma-use-figjam/references/figjam-colors.md)），和帮助中心说的不一致，不确定以哪个为准。
  - sticky 有 10 个预设色。
- **缩小视图**：官方文档没写。
- **折叠**：
  - FigJam 的 section 可以隐藏内容（[FigJam sections](https://help.figma.com/hc/en-us/articles/4939765379351-Organize-your-FigJam-board-with-sections)）。插件 API 有对应的 `sectionContentsHidden` 属性。
  - Figma Design 里没有折叠。
- **成员关系**：数据上是显式的父子关系，section 是图层树里的容器。
  - 但加入的方式是几何操作：把 section 移到对象上、把 section 拉大盖住对象、把对象拖进去或用方向键推进去，都会让对象成为成员。
  - 大小由用户自己调，不自动贴合。
- **交互**：
  - 新建：Shift+S，或者选中对象后右键选「Wrap in new section」。
  - Figma Design 里 section 可以嵌套，但 section 不能放进 frame 或 group。
  - 删除：Delete 连内容一起删；⌘Delete / Ctrl+Backspace 只删 section、保留内容。
  - FigJam 的「Lock background only」只锁住背景，里面的内容仍能编辑。
- **状态**：Dev Mode 的「Ready for dev」状态显示在 section 名字旁边（[Dev Mode statuses](https://help.figma.com/hc/en-us/articles/26781702258583-Dev-Mode-statuses-and-notifications)）。
  - 这个状态是手动标的，不是从成员汇总来的。
  - 标记后如果内容被改，状态会自动变成 Changed，确认之后才回到 Ready for dev。
- **值得注意**：section 用几何操作加入，存的却是显式父子关系，所以之后框和别的东西重叠了，成员也不会变。

### 3.14 Unity Shader Graph group 和 sticky note

版本：Unity-Technologies/Graphics `0efc28e`；UnityCsReference `cf583fb`（GraphView 部分）。

- **group 的外观**：
  - 标题栏里放标题，标题最长 256 字（[Group.cs L12-L83](https://github.com/Unity-Technologies/UnityCsReference/blob/cf583fbe6da6b9fb11e3a1ac03f23df4eb120e9b/Modules/GraphViewEditor/Elements/Group.cs#L12-L83)）。
  - Shader Graph 把 group 的背景设成 `rgba(25,25,25,25/255)`，透明度约 0.1，很淡（[ShaderGroup.cs L22-L27](https://github.com/Unity-Technologies/Graphics/blob/0efc28ea742b1966b9dd9cc4489e58b986a13faf/Packages/com.unity.shadergraph/Editor/Drawing/Views/ShaderGroup.cs#L22-L27)）。
  - 点击和框选只对标题栏有效，点 group 的空白处会穿透到下面（[Scope.cs L94-L106](https://github.com/Unity-Technologies/UnityCsReference/blob/cf583fbe6da6b9fb11e3a1ac03f23df4eb120e9b/Modules/GraphViewEditor/Elements/Scope.cs#L94-L106)）。
  - 标题字号、边框、圆角写在编辑器内部的样式文件里，公开仓库里没有，查不到。
- **sticky note 的外观**：
  - 默认是黄底 `#fcd76e`、深棕字，圆角 2；暗色主题是 `#362905` 底，边框宽 2、圆角 8（[StickyNote.uss L6-L88](https://github.com/Unity-Technologies/Graphics/blob/0efc28ea742b1966b9dd9cc4489e58b986a13faf/Packages/com.unity.shadergraph/Editor/Resources/StickyNote.uss#L6-L88)）。
  - 有标题和正文两块文字。字号分 4 档：标题从 20 到 80，正文从 11 到 56（[Sticky Notes 文档](https://github.com/Unity-Technologies/Graphics/blob/0efc28ea742b1966b9dd9cc4489e58b986a13faf/Packages/com.unity.shadergraph/Documentation~/Sticky-Notes.md)）。
  - 代码里定义了 8 种颜色主题，但实际只启用了亮、暗两种（[StickyNote.cs L39-L49](https://github.com/Unity-Technologies/Graphics/blob/0efc28ea742b1966b9dd9cc4489e58b986a13faf/Packages/com.unity.shadergraph/Editor/Drawing/Views/StickyNote.cs#L39-L49)）。
- **说明文字**：group 只有标题，存盘时只存标题和位置（[GroupData.cs L8-L46](https://github.com/Unity-Technologies/Graphics/blob/0efc28ea742b1966b9dd9cc4489e58b986a13faf/Packages/com.unity.shadergraph/Editor/Data/Graphs/GroupData.cs#L8-L46)）。说明写在 sticky note 里。
- **颜色**：group 不能选色。
- **成员关系**：显式记录，但记在成员身上：每个节点和每张 sticky 都有一个 `m_Group` 字段，指向所属的组（[AbstractMaterialNode.cs L16-L60](https://github.com/Unity-Technologies/Graphics/blob/0efc28ea742b1966b9dd9cc4489e58b986a13faf/Packages/com.unity.shadergraph/Editor/Data/Nodes/AbstractMaterialNode.cs#L16-L60)，[GraphData.cs L160-L216](https://github.com/Unity-Technologies/Graphics/blob/0efc28ea742b1966b9dd9cc4489e58b986a13faf/Packages/com.unity.shadergraph/Editor/Data/Graphs/GraphData.cs#L160-L216)）。
  - 框自动贴合：成员的位置或大小一变，框就跟着重新算（[Scope.cs L28-L45、L243-L259](https://github.com/Unity-Technologies/UnityCsReference/blob/cf583fbe6da6b9fb11e3a1ac03f23df4eb120e9b/Modules/GraphViewEditor/Elements/Scope.cs#L28-L45)）。
  - 不存大小，所以用户不能手动调。
  - 不支持嵌套，源码里写着「Nested group is not supported yet.」（[Group.cs L85-L99](https://github.com/Unity-Technologies/UnityCsReference/blob/cf583fbe6da6b9fb11e3a1ac03f23df4eb120e9b/Modules/GraphViewEditor/Elements/Group.cs#L85-L99)）。
- **交互**：
  - Ctrl/⌘+G 把选中项放进新组，Ctrl/⌘+U 移出（[快捷键文档](https://github.com/Unity-Technologies/Graphics/blob/0efc28ea742b1966b9dd9cc4489e58b986a13faf/Packages/com.unity.shadergraph/Documentation~/Keyboard-shortcuts.md)）。
  - 把元素拖到 group 上就加入，框会自动变大（[GroupDropArea.cs L12-L55](https://github.com/Unity-Technologies/UnityCsReference/blob/cf583fbe6da6b9fb11e3a1ac03f23df4eb120e9b/Modules/GraphViewEditor/Elements/GroupDropArea.cs#L12-L55)）。
  - 拖标题栏，整组一起移动；双击标题栏改名。
  - 右键菜单里有「Delete Group and Contents」，连成员一起删（[MaterialGraphView.cs L426-L437](https://github.com/Unity-Technologies/Graphics/blob/0efc28ea742b1966b9dd9cc4489e58b986a13faf/Packages/com.unity.shadergraph/Editor/Drawing/Views/MaterialGraphView.cs#L426-L437)）。
  - 在两个同组的节点之间插入转接节点时，新节点自动加入这个组（[MaterialGraphView.cs L471-L483](https://github.com/Unity-Technologies/Graphics/blob/0efc28ea742b1966b9dd9cc4489e58b986a13faf/Packages/com.unity.shadergraph/Editor/Drawing/Views/MaterialGraphView.cs#L471-L483)）。
- **缩小视图、折叠、自动布局、运行状态**：都没有。
- **值得注意**：
  - group 只认标题栏的点击，所以背景可以做得极淡。
  - 分组和说明分开：group 只有标题，说明交给 sticky note。

### 3.15 Make.com notes

访问日期 2026-11-17。

- **形式**：notes 没有框，是挂在单个模块或路由上的一个标记。右键模块或路由，选「Add a note」就能添加。不能放在画布空白处（[Scenario notes](https://help.make.com/scenario-notes)）。
  - 有用户想要不挂在模块上的 note，Make 员工的回复是让他去提功能建议，可见目前没有这个功能（[Make 员工发布的功能介绍](https://community.make.com/t/feature-spotlight-updated-notes/68593)）。
- **显示**：分两层。
  - 画布上：悬停标记显示预览，点开看全文，长的可以滚动。
  - 工具栏：有一个 Notes 面板，列出整个场景的所有 notes，可以搜索。
  - 内容是富文本（粗体、列表、emoji、链接），存成 HTML。
  - 每个模块最多 200 条，每条最多 1 万字。
- **其他**：克隆场景或用链接分享场景时，notes 不会带过去。帮助中心没有提到颜色、分组框和缩小视图（[Scenario UI · Make Academy](https://academy-content.make.com/courses/make-foundation-scenarios/01-scenario-ui/)）。
- **值得注意**：说明挂在节点上，画布上只留一个标记，再用一个面板集中列出全部说明。sfly 节点卡片上的备注图标是同一类思路。

## 4. 来源

**Node-RED**（node-red/node-red@e4f7fc5）
- 官方文档 Groups：https://nodered.org/docs/user-guide/editor/workspace/groups
- 1.1 发版博客（引入 groups）：https://nodered.org/blog/2020/06/30/version-1-1-released
- group.js：https://github.com/node-red/node-red/blob/e4f7fc516cd8da1b4b4d571169cf6937b500bb30/packages/node_modules/@node-red/editor-client/src/js/ui/group.js
- view.js：https://github.com/node-red/node-red/blob/e4f7fc516cd8da1b4b4d571169cf6937b500bb30/packages/node_modules/@node-red/editor-client/src/js/ui/view.js
- flow.scss / colors.scss / dark-colors.scss：https://github.com/node-red/node-red/tree/e4f7fc516cd8da1b4b4d571169cf6937b500bb30/packages/node_modules/@node-red/editor-client/src/sass

**ComfyUI / LiteGraph**（Comfy-Org/ComfyUI_frontend@074f766，jagenjo/litegraph.js@0555a2f）
- LGraphGroup.ts：https://github.com/Comfy-Org/ComfyUI_frontend/blob/074f7667aae87d63b80f12ec6b136b99845ead2a/src/lib/litegraph/src/LGraphGroup.ts
- LGraphCanvas.ts：https://github.com/Comfy-Org/ComfyUI_frontend/blob/074f7667aae87d63b80f12ec6b136b99845ead2a/src/lib/litegraph/src/LGraphCanvas.ts
- LiteGraphGlobal.ts：https://github.com/Comfy-Org/ComfyUI_frontend/blob/074f7667aae87d63b80f12ec6b136b99845ead2a/src/lib/litegraph/src/LiteGraphGlobal.ts
- useCoreCommands.ts：https://github.com/Comfy-Org/ComfyUI_frontend/blob/074f7667aae87d63b80f12ec6b136b99845ead2a/src/composables/useCoreCommands.ts
- coreSettings.ts：https://github.com/Comfy-Org/ComfyUI_frontend/blob/074f7667aae87d63b80f12ec6b136b99845ead2a/src/platform/settings/constants/coreSettings.ts
- noteNode.ts：https://github.com/Comfy-Org/ComfyUI_frontend/blob/074f7667aae87d63b80f12ec6b136b99845ead2a/src/extensions/core/noteNode.ts
- 旧 LiteGraph：https://github.com/jagenjo/litegraph.js/blob/0555a2f2a3df5d4657593c6d45eb192359888195/src/litegraph.js
- 子图文档：https://docs.comfy.org/interface/features/subgraph
- Note / MarkdownNote 文档：https://docs.comfy.org/built-in-nodes/Note ，https://docs.comfy.org/built-in-nodes/MarkdownNote

**n8n**（n8n-io/n8n@2ca4d34）
- Sticky notes 文档：https://docs.n8n.io/workflows/components/sticky-notes/
- Canvas Groups 文档：https://docs.n8n.io/build/understand-workflows/workflow-components/canvas-groups
- Sticky.vue：https://github.com/n8n-io/n8n/blob/2ca4d34615dff59312aca57fb998ab5f012cb965/packages/frontend/@n8n/design-system/src/components/N8nSticky/Sticky.vue
- _tokens.scss：https://github.com/n8n-io/n8n/blob/2ca4d34615dff59312aca57fb998ab5f012cb965/packages/frontend/@n8n/design-system/src/css/_tokens.scss
- StickyNote.node.ts：https://github.com/n8n-io/n8n/blob/2ca4d34615dff59312aca57fb998ab5f012cb965/packages/nodes-base/nodes/StickyNote/StickyNote.node.ts
- canvasNodeGroups.constants.ts：https://github.com/n8n-io/n8n/blob/2ca4d34615dff59312aca57fb998ab5f012cb965/packages/frontend/editor-ui/src/features/workflows/canvas/stores/canvasNodeGroups.constants.ts
- CanvasNodeGroupTitleBar.vue：https://github.com/n8n-io/n8n/blob/2ca4d34615dff59312aca57fb998ab5f012cb965/packages/frontend/editor-ui/src/features/workflows/canvas/components/elements/groups/CanvasNodeGroupTitleBar.vue
- useCanvasMapping.groups.ts：https://github.com/n8n-io/n8n/blob/2ca4d34615dff59312aca57fb998ab5f012cb965/packages/frontend/editor-ui/src/features/workflows/canvas/composables/useCanvasMapping.groups.ts
- useCanvasNodeGroupDrag.ts：https://github.com/n8n-io/n8n/blob/2ca4d34615dff59312aca57fb998ab5f012cb965/packages/frontend/editor-ui/src/features/workflows/canvas/composables/useCanvasNodeGroupDrag.ts
- useCanvasLayout.ts：https://github.com/n8n-io/n8n/blob/2ca4d34615dff59312aca57fb998ab5f012cb965/packages/frontend/editor-ui/src/features/workflows/canvas/composables/useCanvasLayout.ts
- interfaces.ts（组的数据结构）：https://github.com/n8n-io/n8n/blob/2ca4d34615dff59312aca57fb998ab5f012cb965/packages/workflow/src/interfaces.ts#L3831-L3836

**Dify**（langgenius/dify@0ba3c9d）
- note-node 目录：https://github.com/langgenius/dify/tree/0ba3c9d76887b6c89c943abaab87f8d86c27d612/web/app/components/workflow/note-node
- operator/hooks.ts：https://github.com/langgenius/dify/blob/0ba3c9d76887b6c89c943abaab87f8d86c27d612/web/app/components/workflow/operator/hooks.ts
- elk-layout.ts：https://github.com/langgenius/dify/blob/0ba3c9d76887b6c89c943abaab87f8d86c27d612/web/app/components/workflow/utils/elk-layout.ts
- types.ts：https://github.com/langgenius/dify/blob/0ba3c9d76887b6c89c943abaab87f8d86c27d612/web/app/components/workflow/types.ts
- 迭代容器：https://github.com/langgenius/dify/tree/0ba3c9d76887b6c89c943abaab87f8d86c27d612/web/app/components/workflow/nodes/iteration

**Langflow**（langflow-ai/langflow@86fde09）
- NoteNode：https://github.com/langflow-ai/langflow/tree/86fde091f88a8b40507512d36ed78b5917dc165e/src/frontend/src/CustomNodes/NoteNode
- constants.ts：https://github.com/langflow-ai/langflow/blob/86fde091f88a8b40507512d36ed78b5917dc165e/src/frontend/src/constants/constants.ts
- SelectionMenuComponent：https://github.com/langflow-ai/langflow/blob/86fde091f88a8b40507512d36ed78b5917dc165e/src/frontend/src/pages/FlowPage/components/SelectionMenuComponent/index.tsx
- reactflowUtils.ts：https://github.com/langflow-ai/langflow/blob/86fde091f88a8b40507512d36ed78b5917dc165e/src/frontend/src/utils/reactflowUtils.ts
- Components 文档：https://docs.langflow.org/concepts-components

**Apache Airflow**（apache/airflow@715043b；2.11.0 = d9ed7b9）
- dags.rst（TaskGroups、doc_md）：https://github.com/apache/airflow/blob/715043b898089c40053108246a0e549f9c16c982/airflow-core/docs/core-concepts/dags.rst
- taskgroup.py：https://github.com/apache/airflow/blob/715043b898089c40053108246a0e549f9c16c982/task-sdk/src/airflow/sdk/definitions/taskgroup.py
- TaskNode.tsx：https://github.com/apache/airflow/blob/715043b898089c40053108246a0e549f9c16c982/airflow-core/src/airflow/ui/src/components/Graph/TaskNode.tsx
- SegmentedStateBar.tsx：https://github.com/apache/airflow/blob/715043b898089c40053108246a0e549f9c16c982/airflow-core/src/airflow/ui/src/components/Graph/SegmentedStateBar.tsx
- elkGraphUtils.ts：https://github.com/apache/airflow/blob/715043b898089c40053108246a0e549f9c16c982/airflow-core/src/airflow/ui/src/components/Graph/elkGraphUtils.ts
- GroupsProvider.tsx：https://github.com/apache/airflow/blob/715043b898089c40053108246a0e549f9c16c982/airflow-core/src/airflow/ui/src/context/groups/GroupsProvider.tsx
- Graph.tsx：https://github.com/apache/airflow/blob/715043b898089c40053108246a0e549f9c16c982/airflow-core/src/airflow/ui/src/layouts/Details/Graph/Graph.tsx
- task_group.py（UI 服务）：https://github.com/apache/airflow/blob/715043b898089c40053108246a0e549f9c16c982/airflow-core/src/airflow/api_fastapi/core_api/services/ui/task_group.py
- grid.py（汇总）：https://github.com/apache/airflow/blob/715043b898089c40053108246a0e549f9c16c982/airflow-core/src/airflow/api_fastapi/core_api/services/ui/grid.py
- misc.py（状态优先级）：https://github.com/apache/airflow/blob/715043b898089c40053108246a0e549f9c16c982/airflow-core/src/airflow/api_fastapi/common/parameters/misc.py#L142-L157
- Airflow 2 DagNode.tsx：https://github.com/apache/airflow/blob/d9ed7b94d033dc61ee1c05aafb9f1c1f7b82cfb2/airflow/www/static/js/dag/details/graph/DagNode.tsx
- Airflow 2 graph.ts：https://github.com/apache/airflow/blob/d9ed7b94d033dc61ee1c05aafb9f1c1f7b82cfb2/airflow/www/static/js/utils/graph.ts

**React Flow / xyflow**（xyflow/xyflow@8256e52）
- Sub Flows 指南：https://reactflow.dev/learn/layouting/sub-flows
- Layouting 概览：https://reactflow.dev/learn/layouting/layouting
- NodeResizer 文档：https://reactflow.dev/api-reference/components/node-resizer
- style.css / xy-theme.css：https://github.com/xyflow/xyflow/tree/8256e52e2c7e9ba270784395817822520a660da1/packages/system/src/styles
- types/nodes.ts：https://github.com/xyflow/xyflow/blob/8256e52e2c7e9ba270784395817822520a660da1/packages/system/src/types/nodes.ts
- types/general.ts：https://github.com/xyflow/xyflow/blob/8256e52e2c7e9ba270784395817822520a660da1/packages/system/src/types/general.ts
- XYResizer.ts：https://github.com/xyflow/xyflow/blob/8256e52e2c7e9ba270784395817822520a660da1/packages/system/src/xyresizer/XYResizer.ts
- Subflow 示例：https://github.com/xyflow/xyflow/blob/8256e52e2c7e9ba270784395817822520a660da1/examples/react/src/examples/Subflow/index.tsx

**Unreal Engine**（UE 5.9 文档）
- Comments：https://dev.epicgames.com/documentation/en-us/unreal-engine/comments-in-unreal-engine
- Organizing a Material Graph：https://dev.epicgames.com/documentation/en-us/unreal-engine/organizing-a-material-graph-in-unreal-engine
- UEdGraphNode_Comment API（打开后跳回首页，未能读取）：https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Editor/UnrealEd/UEdGraphNode_Comment

**Blender**（blender/blender@v4.5.0，手册 blender-v4.5-release）
- node_draw.cc：https://github.com/blender/blender/blob/v4.5.0/source/blender/editors/space_node/node_draw.cc
- node_common.cc：https://github.com/blender/blender/blob/v4.5.0/source/blender/nodes/intern/node_common.cc
- node_relationships.cc：https://github.com/blender/blender/blob/v4.5.0/source/blender/editors/space_node/node_relationships.cc
- transform_convert_node.cc：https://github.com/blender/blender/blob/v4.5.0/source/blender/editors/transform/transform_convert_node.cc
- node_intern.hh：https://github.com/blender/blender/blob/v4.5.0/source/blender/editors/space_node/node_intern.hh
- 默认主题 userdef_default_theme.c：https://github.com/blender/blender/blob/v4.5.0/release/datafiles/userdef/userdef_default_theme.c
- resources.cc（TH_NODE_FRAME 对应主题字段）：https://github.com/blender/blender/blob/v4.5.0/source/blender/editors/interface/resources.cc#L673-L675
- 手册 Frame：https://projects.blender.org/blender/blender-manual/raw/branch/blender-v4.5-release/manual/interface/controls/nodes/frame.rst
- 手册 Editing：https://projects.blender.org/blender/blender-manual/raw/branch/blender-v4.5-release/manual/interface/controls/nodes/editing.rst
- 手册 Arranging：https://projects.blender.org/blender/blender-manual/raw/branch/blender-v4.5-release/manual/interface/controls/nodes/arranging.rst

**Nuke**（Nuke 17.1 用户指南，Python API 14.0）
- Backdrop 参考：https://learn.foundry.com/nuke/content/reference_guide/other_nodes/backdrop.html
- Grouping Nodes：https://learn.foundry.com/nuke/content/comp_environment/organizing_scripts/grouping_nodes.html
- nuke.BackdropNode：https://learn.foundry.com/nuke/developers/140/pythonreference/_autosummary/nuke.BackdropNode.html
- Navigating the Node Graph（书签，搜索摘要）：https://learn.foundry.com/nuke/content/getting_started/using_interface/navigating_node_graph.html
- 二手（仅用于属性名）：https://github.com/charlesangus/anchors

**Houdini**（sidefx.com 当前版文档）
- Organizing networks：https://www.sidefx.com/docs/houdini/network/organize.html
- Network editor menus：https://www.sidefx.com/docs/houdini/network/menus.html
- hou.NetworkBox：https://www.sidefx.com/docs/houdini/hom/hou/NetworkBox.html
- hou.NetworkItem：https://www.sidefx.com/docs/houdini/hom/hou/NetworkItem.html
- hou.StickyNote：https://www.sidefx.com/docs/houdini/hom/hou/StickyNote.html

**TouchDesigner**
- Annotate COMP：https://docs.derivative.ca/Annotate_COMP
- Comments, Network Boxes, Annotates：https://docs.derivative.ca/Network_Utilities:_Comments,_Network_Boxes,_Annotates

**Figma / FigJam**
- Organize your canvas with sections：https://help.figma.com/hc/en-us/articles/9771500257687-Organize-your-canvas-with-sections
- Organize your FigJam board with sections：https://help.figma.com/hc/en-us/articles/4939765379351-Organize-your-FigJam-board-with-sections
- Dev Mode statuses and notifications：https://help.figma.com/hc/en-us/articles/26781702258583-Dev-Mode-statuses-and-notifications
- Apply colors in FigJam：https://help.figma.com/hc/en-us/articles/1500004291341-Apply-colors-in-FigJam
- Sticky notes in FigJam：https://help.figma.com/hc/en-us/articles/1500004414322-Sticky-notes-in-FigJam
- SectionNode（插件 API）：https://developers.figma.com/docs/plugins/api/SectionNode/
- Figma 官方 MCP 指南（figma/mcp-server-guide@490a73c）：https://github.com/figma/mcp-server-guide/blob/490a73c7537123cb1f0bcaced658585f0ee32fd9/skills/figma-use-figjam/references/create-section.md ，https://github.com/figma/mcp-server-guide/blob/490a73c7537123cb1f0bcaced658585f0ee32fd9/skills/figma-use-figjam/references/figjam-colors.md

**Unity Shader Graph**（Unity-Technologies/Graphics@0efc28e，UnityCsReference@cf583fb）
- Sticky Notes 文档：https://github.com/Unity-Technologies/Graphics/blob/0efc28ea742b1966b9dd9cc4489e58b986a13faf/Packages/com.unity.shadergraph/Documentation~/Sticky-Notes.md
- 快捷键文档：https://github.com/Unity-Technologies/Graphics/blob/0efc28ea742b1966b9dd9cc4489e58b986a13faf/Packages/com.unity.shadergraph/Documentation~/Keyboard-shortcuts.md
- ShaderGroup.cs：https://github.com/Unity-Technologies/Graphics/blob/0efc28ea742b1966b9dd9cc4489e58b986a13faf/Packages/com.unity.shadergraph/Editor/Drawing/Views/ShaderGroup.cs
- StickyNote.cs / StickyNote.uss：https://github.com/Unity-Technologies/Graphics/blob/0efc28ea742b1966b9dd9cc4489e58b986a13faf/Packages/com.unity.shadergraph/Editor/Drawing/Views/StickyNote.cs ，https://github.com/Unity-Technologies/Graphics/blob/0efc28ea742b1966b9dd9cc4489e58b986a13faf/Packages/com.unity.shadergraph/Editor/Resources/StickyNote.uss
- MaterialGraphView.cs：https://github.com/Unity-Technologies/Graphics/blob/0efc28ea742b1966b9dd9cc4489e58b986a13faf/Packages/com.unity.shadergraph/Editor/Drawing/Views/MaterialGraphView.cs
- GroupData.cs / GraphData.cs / AbstractMaterialNode.cs：https://github.com/Unity-Technologies/Graphics/tree/0efc28ea742b1966b9dd9cc4489e58b986a13faf/Packages/com.unity.shadergraph/Editor/Data
- GraphView Group.cs / Scope.cs / GroupDropArea.cs：https://github.com/Unity-Technologies/UnityCsReference/tree/cf583fbe6da6b9fb11e3a1ac03f23df4eb120e9b/Modules/GraphViewEditor/Elements

**Make.com**
- Scenario notes：https://help.make.com/scenario-notes
- Feature Spotlight: Updated Notes（Make 员工在官方社区发布）：https://community.make.com/t/feature-spotlight-updated-notes/68593
- Scenario UI（Make Academy）：https://academy-content.make.com/courses/make-foundation-scenarios/01-scenario-ui/

## 4. LibTV（实际登录操作）

调研日期：2026-11-17。在 liblib.tv 上打开公开画布和分享画布「【元素替换】功能介绍」，再在用户账号里新建一张临时画布，只放文本节点，试了成组、改色、改名、拖进拖出和整理画布；试完删掉了这张画布。下面的数值来自页面的 DOM 和计算样式（`getComputedStyle`），不是二手资料。LibTV 的画布也是 React Flow（`.react-flow__node-group` 等类名）。

- **分组是 React Flow 的父节点**：
  - 默认底色和描边都是 `#ffffff1a`（10% 白，变量 `--canvas-group-bg`、`--canvas-group-border`），圆角 20，在节点下面（`z-index: -1001`）。画布底色 `#1a1a1a`，叠出来约 `#313131`，比画布亮不少。
  - 标题写在框外上方 8px（`bottom: calc(100% + 8px)`），13px、灰色（`text-fg-muted`，`rgb(145,145,145)`）。标题按缩放比例反向放大（`transform: scale(1/zoom)`），任何缩放下屏幕上都是 13px，缩到 10% 也读得清。
  - 新建的分组叫「Group 1」；公开画布里没改名的分组显示「分组 15 个节点」这样带节点数的标题。
- **节点和说明卡片比分组暗**：
  - 节点底色 `#191e26`（`--canvas-node-bg`，偏蓝的深色），文本节点 `#171717`，描边是 8% 白，圆角 16。层次靠「亮底板上放暗卡片」拉开。
  - 节点标题也写在卡片外上方（`top: -28px`），带种类图标，最多放大 2 倍（`scale(2)` 封顶），所以缩小时比分组标题小，主次自然分开。
- **颜色**：
  - 分组和文本节点共用一套 10 色色板：灰（默认）、红、橙、黄、绿、青、蓝、紫、粉、白。
  - 分组选色后底色是该色 10%、描边 20%（例如绿色 `rgba(46,204,113,0.1)` / `0.2`），标题变成同色的小胶囊。
  - 文本节点选色后底色是该色约 12% 叠在深底上（黄 `rgb(49,43,23)`、绿 `rgb(26,45,34)`），描边仍是 8% 白。
- **便签就是文本节点**：
  - 添加节点菜单里没有单独的「便签」或「分组」。
  - 说明卡片是普通文本节点：独立摆放（可以在分组外，也可以放进分组），能调大小，有格式工具条（颜色、正文 / 标题级别、粗体、斜体、分隔线、展开）。
  - 分享画布「【元素替换】功能介绍」的「功能上新！」「功能介绍」「动作迁移」三张卡片都在分组外。
- **成组和成员**：
  - 多选后工具条有「打组」（Ctrl/Alt+G），解组是 Ctrl/Alt+Shift+G。
  - 新分组的大小是所选节点的外接框，四周再留约 50px。之后**大小固定**，选中时四角有手柄可以拉伸，成员移出也不缩小。
  - 节点**完整**拖进框里才加入，拖的过程中框高亮；只进去一部分不算。拖出框就离开。没选中的节点即使压在框上也不是成员。
  - 双击标题原地改名。
  - 分组工具条：颜色、排列（宫格 / 水平 / 垂直）、整组执行、添加到我的预设、转分镜组、解组。
  - 右键菜单：复制节点、创建副本、粘贴、删除、复制到剪贴板。没有折叠。
- **整理**：
  - 多选或选中分组时可以「宫格排列 / 水平排列 / 垂直排列」。
  - 「整理画布」（Alt+Shift+F）把分组当一个整体排，组里的布局不动；整理后左下角问「是否保留此次整理结果？还原 / 保留」，视图缩放到能看全。
  - 拖动时有对齐参考线（蓝色虚线），另有「网格吸附」开关。
- **找东西**：
  - 左侧节点大纲按分组列出：分组是文件夹，下面是成员，没进分组的节点列在最上面；可以搜索、筛选，底部显示总节点数，点击定位。
  - 小地图把分组画成一整块。
- **毛病**：分组排得密时，框外标题会压到上面别的分组里（公开画布「元素替换一键复刻爆款视频」，缩到 10% 时可见）。

**对 sfly 的启发**（和第 1 节对照）：框外标题、比画布亮的底板、缩小时标题不缩小，这些我们已经做了；还缺的是：颜色可选、独立的说明卡片（便签）、拖进 / 拖出改成员、双击改名、Ctrl+G 成组、整理所选（宫格 / 水平 / 垂直）、整理后「保留 / 还原」、按注释框分组的节点大纲。LibTV 的分组大小固定、要手动拉伸，这和我们「框自动贴合成员、命令行不写坐标」（ADR 0023）不同，搬过来时要取舍。
