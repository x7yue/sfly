import { useEffect, useId } from "react";

/** 确认弹窗（视觉参照原型 modal.css）：标题、说明、内容、底部操作；Esc 关闭。 */
export function Modal({
	title,
	description,
	children,
	footer,
	onClose,
}: {
	title: string;
	description?: React.ReactNode;
	children?: React.ReactNode;
	footer: React.ReactNode;
	onClose: () => void;
}) {
	const titleId = useId();
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);
	return (
		<div className="sf-modal-bg">
			<div className="sf-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
				<div className="sf-modal__h">
					<h2 id={titleId}>{title}</h2>
					{description && <p>{description}</p>}
				</div>
				{children && <div className="sf-modal__b">{children}</div>}
				<div className="sf-modal__f">{footer}</div>
			</div>
		</div>
	);
}
