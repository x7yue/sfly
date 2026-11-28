/**
 * 产物的地址（#434 CODE-5）：控制面拼出对 Agent 可见的完整下载地址（节点输出里的产物引用，SDK 返回给节点的就是它），
 * 运行监控把输出里的产物引用认出来、换成浏览器的下载地址。拼和认只在这里写一次，路径改了两边一起变。
 * 地址是 `<对外地址>/tasks/<任务 ID>/artifacts/<名称>`：名称按 `/` 分段，每段百分号编码。
 */

/** 任务 ID 是 UUID。 */
const TASK_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ARTIFACT_REF = new RegExp(
	`^https?://[^\\s"]*/tasks/(${TASK_ID})/artifacts/([^\\s"?#]+)$`,
	"i",
);

/** 任务产物的上传 / 下载地址前缀（以 `/` 结尾），后面接按路径段编码的产物名称。 */
export function artifactBaseUrl(publicHttpUrl: string, taskId: string): string {
	return `${publicHttpUrl}/tasks/${taskId}/artifacts/`;
}

/** 某个产物的下载地址（也是 SDK 返回给节点的产物引用）。 */
export function artifactUrl(publicHttpUrl: string, taskId: string, name: string): string {
	return artifactBaseUrl(publicHttpUrl, taskId) + name.split("/").map(encodeURIComponent).join("/");
}

/** {@link artifactUrl} 拼出的地址拆回任务 ID 和产物名称（解码之后）；不是产物引用、或百分号编码不合法时为 null。 */
export function parseArtifactUrl(value: string): { taskId: string; name: string } | null {
	const m = ARTIFACT_REF.exec(value);
	if (!m?.[1] || !m[2]) return null;
	try {
		return { taskId: m[1], name: m[2].split("/").map(decodeURIComponent).join("/") };
	} catch {
		return null;
	}
}
