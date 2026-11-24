import { cn } from "cn";
import {
	createContext,
	type ReactElement,
	type ReactNode,
	type Ref,
	useContext,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { UntrustedText } from "#/components/untrusted-text";
import { untrustedPlain } from "#/lib/untrusted-text";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * 单行截断（docs/DESIGN-SYSTEM.md「长文本与截断」）：放不下时末尾省略；真的被截断时，悬停或键盘聚焦都会弹出全文。
 * 全文始终在 DOM 里（读屏、页内查找、复制拿到的都是全文），提示只是给看得见的人补上被截掉的部分。
 *
 *   <Truncate>{scenario.name}</Truncate>                                   // 普通文字：截断时可以 Tab 到它
 *   <Truncate render={<Link to=… data-list-primary />}>{name}</Truncate>   // 链接、按钮本身截断：聚焦它就弹出
 *   <Truncate keepEnd={6}>{"sfly-stub/metric_rate@0.1.0"}</Truncate>       // 结尾 6 个字符始终可见（版本号）
 *   <Truncate untrusted>{agent.name}</Truncate>                            // 别人写的、不保证内容的文字：见下面
 *
 * **别人写的文字（Agent 报的名称和版本、节点的元信息、产物的名称……）传 `untrusted`**：和 `UntrustedText` 一样，文字方向隔离在自己的范围里，
 * 看不见的字符和控制字符写成看得见的样子（提示里的全文也是）；没传 `untrusted` 的 `Truncate` 不处理文字（docs/DESIGN-SYSTEM.md「不可信的文字」）。
 * 带 `keepEnd` 时写出来的字符是 `⟨U+202E⟩` 这样的一小段字（按字符数截，放不了组件），否则是和 `UntrustedText` 一样的一小块。
 *
 * 按钮、链接里除了文字还有图标、徽标，或者有好几段文字都可能被截断时，传 `render` 和 `label`（提示里的全文）：
 * 按钮本身是提示的触发器，里面嵌套的 `Truncate` 只负责截断，不再自己弹提示、不多一个可聚焦的元素。
 * 按钮自己被 CSS 截断（`truncate`）也算；里面一行高的元素标 `data-truncate-wrap`，放不下的内容换到被裁掉的第二行时同样算被截断。提示在悬停或聚焦、真要打开的那一刻才量有没有被截断。
 *
 *   <Truncate render={<button … className="flex min-w-0 …" />} label={`${name} · ${title}`}>
 *     <StatusDot />
 *     <Truncate>{name}</Truncate>
 *   </Truncate>
 *
 * 外层要给它一个有限的宽度（flex / grid 里的项写 `min-w-0`）。标题不用它：标题最多两行（`line-clamp-2`），不截成一行。
 */
type TruncateProps = { className?: string } & (
	| {
			children: string;
			/** 结尾始终显示的字符数：版本号、扩展名这类最有区分度的部分。 */
			keepEnd?: number;
			/** 别人写的、不保证内容的文字：方向隔离，看不见的字符和控制字符写出来（见上）。 */
			untrusted?: boolean;
			/** 截断的是交互元素本身（链接、按钮）时传入它，提示跟着它的悬停与聚焦出现。 */
			render?: ReactElement<Record<string, unknown>>;
			label?: undefined;
	  }
	| {
			children: ReactNode;
			keepEnd?: undefined;
			untrusted?: undefined;
			/** 交互元素本身：里面有别的内容，被截断的文字用嵌套的 `Truncate`。 */
			render: ReactElement<Record<string, unknown>>;
			/** 提示里的全文。 */
			label: string;
	  }
);

/** 在会提示全文的交互元素里面：里面的 `Truncate` 只截断，提示由外层的元素给。 */
const WithinControl = createContext(false);

export function Truncate(props: TruncateProps) {
	const within = useContext(WithinControl);
	if (props.label !== undefined) return <ControlTruncate {...props} />;
	if (within) return <PlainTruncate {...props} />;
	return <TextTruncate {...props} />;
}

/**
 * 截断的那一层：`data-truncate-clip` 让外层的交互元素找到它、量它有没有被截断。`untrusted`：别人写的文字，方向隔离
 * （`dir="ltr"` 加 `unicode-bidi: isolate`：**基准方向一律是从左到右**，和整个控制台一样；不用 `dir="auto"`，那样以从右到左的字母开头的
 * 混排文字会整行翻过来，省略号也跑到另一头，和不经过这里时的显示不一样）；
 * 不带 `keepEnd` 时 `children` 可以是组件（`UntrustedText`），带 `keepEnd` 时必须是字符串（按字符数拆成两段）。
 */
function Clipped({
	children,
	keepEnd = 0,
	clipRef,
	untrusted = false,
}: {
	children: ReactNode;
	keepEnd?: number;
	clipRef?: Ref<HTMLSpanElement>;
	untrusted?: boolean;
}) {
	const isolate = untrusted ? { dir: "ltr" as const, className: "[unicode-bidi:isolate]" } : {};
	const split = keepEnd > 0 && typeof children === "string" && keepEnd < children.length;
	// 拆成两段画时读屏会在两段之间读出一个停顿（「sub _ping」）：看得见的两段对读屏隐藏，读屏读完整的一段。
	return split ? (
		<span className="flex min-w-0 whitespace-nowrap">
			<span className="sr-only">{children}</span>
			<span
				aria-hidden
				ref={clipRef}
				data-truncate-clip=""
				{...isolate}
				className={cn("truncate", isolate.className)}
			>
				{children.slice(0, -keepEnd)}
			</span>
			<span aria-hidden {...isolate}>
				{children.slice(-keepEnd)}
			</span>
		</span>
	) : (
		<span
			ref={clipRef}
			data-truncate-clip=""
			{...isolate}
			className={cn("block truncate", isolate.className)}
		>
			{children}
		</span>
	);
}

function TextTruncate({
	children,
	keepEnd = 0,
	render,
	className,
	untrusted = false,
}: {
	children: string;
	keepEnd?: number;
	render?: ReactElement<Record<string, unknown>> | undefined;
	className?: string | undefined;
	untrusted?: boolean | undefined;
}) {
	const clipped = useRef<HTMLSpanElement>(null);
	const [truncated, setTruncated] = useState(false);
	// 别人写的文字：带 keepEnd（按字符数拆开）时先把看不见的字符换成纯文字，不带时用组件。
	const shown = untrusted ? untrustedShown(children, keepEnd) : children;
	// biome-ignore lint/correctness/useExhaustiveDependencies: ResizeObserver 只在尺寸变化时回调，文字变了要重新量
	useLayoutEffect(() => {
		const element = clipped.current;
		if (!element) return;
		const check = () => setTruncated(element.scrollWidth > element.clientWidth);
		check();
		const observer = new ResizeObserver(check);
		observer.observe(element);
		return () => observer.disconnect();
	}, [children, keepEnd]);

	return (
		<Tooltip disabled={!truncated}>
			<TooltipTrigger
				data-slot="truncate"
				data-truncated={truncated || undefined}
				render={render ?? <span tabIndex={truncated ? 0 : undefined} className="block min-w-0" />}
				className={cn("min-w-0", className)}
			>
				<Clipped keepEnd={keepEnd} clipRef={clipped} untrusted={untrusted}>
					{shown}
				</Clipped>
			</TooltipTrigger>
			<TooltipContent className="max-w-md wrap-anywhere">
				{untrusted ? <UntrustedText text={children} /> : children}
			</TooltipContent>
		</Tooltip>
	);
}

/** 别人写的文字在 `Truncate` 里的样子：不拆开的是组件（一小块写出来的字符），按字符数拆开的是纯文字。 */
function untrustedShown(text: string, keepEnd: number): ReactNode {
	return keepEnd > 0 ? untrustedPlain(text) : <UntrustedText text={text} />;
}

/** 在交互元素里面：只截断，和单独的 Truncate 一样的版面，没有提示、不能聚焦。 */
function PlainTruncate({
	children,
	keepEnd = 0,
	className,
	untrusted = false,
}: {
	children: string;
	keepEnd?: number;
	render?: unknown;
	className?: string | undefined;
	untrusted?: boolean | undefined;
}) {
	return (
		<span className={cn("block min-w-0", className)}>
			<Clipped keepEnd={keepEnd} untrusted={untrusted}>
				{untrusted ? untrustedShown(children, keepEnd) : children}
			</Clipped>
		</span>
	);
}

function ControlTruncate({
	children,
	render,
	label,
	className,
}: {
	children: ReactNode;
	render: ReactElement<Record<string, unknown>>;
	label: string;
	className?: string | undefined;
}) {
	const trigger = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	/** 元素自己或里面哪一段文字被截断了。 */
	const clipped = () => {
		const element = trigger.current;
		if (!element) return false;
		const parts = [
			element,
			...element.querySelectorAll<HTMLElement>("[data-truncate-clip], [data-truncate-wrap]"),
		];
		return parts.some(
			(part) =>
				part.scrollWidth > part.clientWidth ||
				// 一行高、放不下的内容换到被裁掉的第二行（`NodeName` 的 `priority="name"`）。
				(part.hasAttribute("data-truncate-wrap") && part.scrollHeight > part.clientHeight),
		);
	};
	return (
		<Tooltip open={open} onOpenChange={(next) => setOpen(next && clipped())}>
			<TooltipTrigger ref={trigger} data-slot="truncate" render={render} className={className}>
				<WithinControl.Provider value>{children}</WithinControl.Provider>
			</TooltipTrigger>
			<TooltipContent className="max-w-md wrap-anywhere whitespace-pre-line">
				{label}
			</TooltipContent>
		</Tooltip>
	);
}
