import { useState } from "react";
import { setNickname, useNickname } from "#/lib/nickname";

/** 第一次打开页面时填写昵称；昵称只用于显示（版本作者、运行触发人、在线编辑者），不做鉴权。 */
export function NicknameGate() {
	const nickname = useNickname();
	const [value, setValue] = useState("");
	if (nickname !== null) return null;

	return (
		<div className="fixed inset-0 z-50 grid place-items-center bg-black/40">
			<form
				className="w-80 rounded-lg bg-white p-5 shadow-xl"
				onSubmit={(e) => {
					e.preventDefault();
					if (value.trim()) setNickname(value.trim());
				}}
			>
				<h2 className="text-lg font-semibold">欢迎使用 sfly</h2>
				<p className="mt-1 text-sm text-gray-500">
					请填写昵称。它会标记你保存的版本和触发的运行，只保存在这个浏览器里。
				</p>
				<input
					aria-label="昵称"
					// biome-ignore lint/a11y/noAutofocus: 打开页面后先填写昵称
					autoFocus
					className="mt-3 w-full rounded border border-gray-300 px-2 py-1 outline-none focus:border-blue-500"
					value={value}
					onChange={(e) => setValue(e.target.value)}
					placeholder="昵称"
				/>
				<button
					type="submit"
					disabled={!value.trim()}
					className="mt-3 w-full rounded bg-blue-600 py-1 font-medium text-white disabled:opacity-50"
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
			className="text-sm text-gray-600 hover:underline"
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
