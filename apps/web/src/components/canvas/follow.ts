import { type LayoutDocument, subflowRegions } from "@sfly/orchestration";
import type { Rect, Viewport } from "@xyflow/react";
import { type CanvasInsets, NODE_HEIGHT, NODE_WIDTH } from "./geometry";

/**
 * 跟随执行（运行状态）的镜头框选，纯逻辑，单测见 follow.test.ts：镜头框住所有执行中的节点，
 * 子流程里的节点连同它的子流程区域一起框进来；框在没被悬浮控件（顶栏、右侧的检查器、工具条）占住的可见区域里，
 * 放在它的正中，缩放夹在 {@link FOLLOW_ZOOM}。卡片按布局里量出来的高度算（运行状态下卡片显示关注项、正在做的事时会长高），
 * 子流程区域也跟着长高。
 */

/** 跟随时的缩放范围：不缩得比 0.6 小（节点上的字还能读），不放得比 1 大。 */
export const FOLLOW_ZOOM = { min: 0.6, max: 1 } as const;

/** 执行前沿（执行中的节点）变化之后，镜头停留这么久才平移：一连串很快结束的节点不会让镜头连跳。 */
export const FOLLOW_DWELL_MS = 2000;

/**
 * 什么时候框：跟随刚打开时马上框一次；之后执行前沿的 `key` 变了，停留 {@link FOLLOW_DWELL_MS} 才框，
 * 停留期间又变了就重新计时。`key` 为 null（跟随关了、画布还没就绪）时取消等待，下次打开重新马上框；`cancel` 在画布卸载时用。
 */
export function createFrameScheduler() {
	let framed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const cancel = () => {
		clearTimeout(timer);
		framed = false;
	};
	return {
		update(key: string | null, frame: () => void) {
			if (key === null) return cancel();
			clearTimeout(timer);
			if (!framed) {
				framed = true;
				frame();
			} else {
				timer = setTimeout(frame, FOLLOW_DWELL_MS);
			}
		},
		cancel,
	};
}

/** 框住的内容与可见区域边缘的留白（屏幕像素）。 */
const FRAME_PADDING = 24;

const unionOf = (rects: readonly Rect[]): Rect => {
	const x = Math.min(...rects.map((r) => r.x));
	const y = Math.min(...rects.map((r) => r.y));
	return {
		x,
		y,
		width: Math.max(...rects.map((r) => r.x + r.width)) - x,
		height: Math.max(...rects.map((r) => r.y + r.height)) - y,
	};
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * 框住 `running`（执行中的节点 ID）的视口；画布上没有这些节点时是 null。
 * `area` 是视口四周被悬浮控件占住的宽度，检查器的宽度在 `area.right` 里；`size` 是画布容器的大小。
 */
export function followViewport({
	running,
	layout,
	size,
	area,
}: {
	running: readonly string[];
	layout: LayoutDocument;
	size: { width: number; height: number };
	area: CanvasInsets;
}): Viewport | null {
	const regions = subflowRegions(layout);
	const nodes = new Map(layout.nodes.map((n) => [n.id, n]));
	const framed = running.flatMap((id): Rect[] => {
		const region = regions.find((r) => r.members.includes(id));
		if (region) {
			return [{ x: region.box.x, y: region.box.y, width: region.box.w, height: region.box.h }];
		}
		const node = nodes.get(id);
		const at = node?.position;
		return at ? [{ x: at.x, y: at.y, width: NODE_WIDTH, height: node.height ?? NODE_HEIGHT }] : [];
	});
	if (framed.length === 0) return null;

	const bounds = unionOf(framed);
	const visible = {
		width: size.width - area.left - area.right,
		height: size.height - area.top - area.bottom,
	};
	const zoom = clamp(
		Math.min(
			(visible.width - 2 * FRAME_PADDING) / bounds.width,
			(visible.height - 2 * FRAME_PADDING) / bounds.height,
		),
		FOLLOW_ZOOM.min,
		FOLLOW_ZOOM.max,
	);
	return {
		x: area.left + visible.width / 2 - (bounds.x + bounds.width / 2) * zoom,
		y: area.top + visible.height / 2 - (bounds.y + bounds.height / 2) * zoom,
		zoom,
	};
}
