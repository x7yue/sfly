// components/ui 自己渲染原生 <table>：不拦。
export function Table(props: TableProps) {
	return (
		<table className="w-full">
			<tbody>{props.children}</tbody>
		</table>
	);
}
