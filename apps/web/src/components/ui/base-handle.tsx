import { Handle } from "@xyflow/react";
import { cn } from "cn";
import type { ComponentProps } from "react";

/**
 * React Flow UI 的 BaseHandle（https://reactflow.dev/ui/components/base-handle，拉取后按设计体系改写）：
 * 端口常显的小圆点。`data-state`：
 *   connected  已连接——实心
 *   open       链尾，可以从这里拖线追加——虚线空心
 *   idle       未连接——空心
 * 调度端口（`variant="dispatch"`）是信号色描边的菱形。位置与尺寸由使用方以 style 给出。
 * 可按的范围比看到的圆点大（透明的 `::before`），拖线不必对准 9px 的圆点。
 */
export function BaseHandle({
	className,
	state = "idle",
	variant = "chain",
	...props
}: ComponentProps<typeof Handle> & {
	state?: "connected" | "open" | "idle";
	variant?: "chain" | "dispatch";
}) {
	return (
		<Handle
			data-state={state}
			className={cn(
				"min-h-0! min-w-0! border-[1.5px] border-canvas-port bg-canvas-bg",
				// 命中范围比圆点大：透明的伪元素向四周各伸出 8px，外观不变。
				"before:absolute before:-inset-2 before:rounded-full",
				variant === "chain" ? "rounded-full" : "rounded-[2px] border-canvas-edge-dispatch",
				"data-[state=connected]:border-canvas-edge data-[state=connected]:bg-canvas-edge",
				variant === "dispatch" && "data-[state=connected]:border-canvas-edge-dispatch",
				"data-[state=open]:border-dashed",
				className,
			)}
			{...props}
		/>
	);
}
