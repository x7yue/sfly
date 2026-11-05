# 组件库使用 shadcn/ui（底层原语 Base UI），组件代码归仓库自己维护

前端需要一套自定义的深色专业工具视觉（中性灰阶、白色是唯一主操作、青色只做信号色），以及以 React Flow 为核心的画布。对比 Mantine 9 与 shadcn/ui（Base UI）的一手资料和动手原型后选择 shadcn/ui：组件代码复制进仓库，设计 token 直接写进组件，不需要覆盖库的内部类名；与 Tailwind v4 原生一致；xyflow 官方的 React Flow UI 组件基于 shadcn；Base UI 的 Combobox、焦点回归等无障碍行为开箱更规范。组件先用 shadcn CLI 拉取，之后视为自己的代码，不跟随上游的每次调整，确有需要时再手动对比合并；缺少的组件（数字输入、快捷键等）按同样方式自己补。

## Considered Options

- **Mantine**：组件最齐、自写代码最少；但主题语义（10 级色阶、主色泄漏到焦点环等、size 同时管高度和字号）与我们的视觉体系冲突，需要依赖内部类名的覆盖，大版本升级成本高；命令面板的无障碍缺口无法通过参数修正。
- **React Aria Components**：无障碍最好，但样式和组合几乎全部自写。
- **Ant Design**：企业后台视觉，改成炭灰工具风成本最高。

## Consequences

- 约 2500 行组件代码进入仓库，由我们维护，包括修复其中的无障碍问题。
