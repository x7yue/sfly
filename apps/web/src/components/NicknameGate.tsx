import { useState } from "react";
import { setNickname, useNickname } from "#/lib/nickname";

/** 第一次打开页面时填写昵称；昵称只用于显示（版本作者、运行触发人、在线编辑者），不做鉴权。 */
export function NicknameGate() {
	const nickname = useNickname();
	const [value, setValue] = useState("");
	if (nickname !== null) return null;

	return (
		<div className="sf-gate">
			<form
				className="sf-gate__form"
				onSubmit={(e) => {
					e.preventDefault();
					if (value.trim()) setNickname(value.trim());
				}}
			>
				<h2 className="text-lg font-semibold">欢迎使用 sfly</h2>
				<p className="sf-hint">
					请填写昵称。它会标记你保存的版本和触发的运行，只保存在这个浏览器里。
				</p>
				<input
					aria-label="昵称"
					// biome-ignore lint/a11y/noAutofocus: 打开页面后先填写昵称
					autoFocus
					className="sf-inp mt-3"
					value={value}
					onChange={(e) => setValue(e.target.value)}
					placeholder="昵称"
				/>
				<button
					type="submit"
					disabled={!value.trim()}
					className="sf-btn sf-btn--primary mt-3 w-full"
				>
					开始使用
				</button>
			</form>
		</div>
	);
}

/** 导航栏里显示当前昵称，可以修改。 */
export function NicknameBadge() {
	const nickname = useNickname();
	if (!nickname) return null;
	return (
		<button
			type="button"
			className="sf-nav__nick"
			title="修改昵称"
			onClick={() => {
				const next = window.prompt("修改昵称", nickname)?.trim();
				if (next) setNickname(next);
			}}
		>
			{nickname}
		</button>
	);
}
