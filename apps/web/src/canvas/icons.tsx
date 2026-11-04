/** 线性图标（24×24，取自画布原型 src/data/icons.js），尺寸和描边由 .sf-icon 控制。 */
const PATHS = {
	play: <path d="M7 4l12 8-12 8V4z" />,
	route: (
		<>
			<circle cx="6" cy="19" r="2.5" />
			<circle cx="18" cy="5" r="2.5" />
			<path d="M8.5 19H16a3.5 3.5 0 0 0 0-7H8a3.5 3.5 0 0 1 0-7h7.5" />
		</>
	),
	zap: <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />,
	clock: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 7v5l3 2" />
		</>
	),
	timer: (
		<>
			<circle cx="12" cy="13" r="8" />
			<path d="M12 9v4l2.5 2M9 2h6" />
		</>
	),
	cpu: (
		<>
			<rect x="6" y="6" width="12" height="12" rx="2" />
			<path d="M10 10h4v4h-4zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
		</>
	),
	link: (
		<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
	),
	check: <path d="M5 12l5 5 9-10" />,
	x: <path d="M6 6l12 12M18 6L6 18" />,
	alert: <path d="M12 3l10 18H2L12 3zM12 10v5M12 18h.01" />,
	info: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 11v5M12 8h.01" />
		</>
	),
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name }: { name: IconName }) {
	return (
		<svg className="sf-icon" viewBox="0 0 24 24" aria-hidden="true">
			{PATHS[name]}
		</svg>
	);
}
