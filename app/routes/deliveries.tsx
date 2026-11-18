import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import type { Delivery } from "../../workers/backup/model";
const labels = {
	pending: "待处理",
	retrying: "自动重试中",
	submitted: "已提交发送",
	failed: "失败，需处理",
	uncertain: "发送结果未知，需核对",
};
export default function Deliveries() {
	const [attention, setAttention] = useState(true);
	const [cursor, setCursor] = useState("");
	const [error, setError] = useState("");
	const { data, refetch, isLoading, isError } = useQuery({
		queryKey: ["deliveries", cursor, attention],
		queryFn: async () => {
			const r = await fetch(
				"/api/v1/deliveries?attention=" +
					attention +
					"&cursor=" +
					encodeURIComponent(cursor),
			);
			if (!r.ok) throw new Error("无法加载投递记录");
			return r.json() as Promise<{
				deliveries: Delivery[];
				cursor: string | null;
			}>;
		},
		refetchInterval: 10000,
	});
	async function retry(d: Delivery) {
		if (
			!window.confirm(
				"请先核对目标邮箱，确认未收到此副本。继续重试可能产生重复邮件，是否继续？",
			)
		)
			return;
		const r = await fetch(
			`/api/v1/deliveries/${encodeURIComponent(d.mailbox)}/${d.id}/retry`,
			{ method: "POST" },
		);
		if (!r.ok) setError("重试未成功，请刷新后再试。");
		else {
			setError("");
			await refetch();
		}
	}
	return (
		<main className="max-w-3xl mx-auto p-5 space-y-4">
			<Link to="/">返回邮箱目录</Link>
			<h1 className="text-xl font-bold">来信副本投递</h1>
			<p>
				“已提交发送”表示发送服务已接受，不代表目标收件箱已收录。请同时关注目标邮箱的垃圾箱。
			</p>
			<p role="alert">
				{error || (isError ? "无法加载投递记录，请重试。" : "")}
			</p>
			<label>
				<input
					type="checkbox"
					checked={attention}
					onChange={(e) => {
						setAttention(e.target.checked);
						setCursor("");
					}}
				/>{" "}
				只看需要处理的副本
			</label>{" "}
			<button onClick={() => refetch()}>刷新</button>
			{isLoading && <p>加载中…</p>}
			{data?.deliveries.length === 0 && (
				<p>暂无副本投递记录。历史邮件不会自动补发。</p>
			)}
			{data?.deliveries.map((d) => (
				<article
					key={d.id}
					className="border rounded p-4 space-y-2 break-words"
				>
					<strong>{d.subject}</strong>
					<p>学生邮箱：{d.mailbox}</p>
					<p>目标邮箱：{d.target}</p>
					<p
						role={
							["failed", "uncertain", "retrying"].includes(d.state)
								? "alert"
								: undefined
						}
					>
						{labels[d.state]} · 已尝试 {d.attempts} 次 ·{" "}
						{d.inboxStored ? "Inbox 已保存" : "Inbox 尚未保存"}
					</p>
					{d.error && <p>{d.error}</p>}
					{d.history && (
						<details>
							<summary>处理记录</summary>
							{d.history.map((h, i) => (
								<p key={i}>
									{new Date(h.at).toLocaleString()} · {labels[h.state]} · 第{" "}
									{h.attempts} 次 {h.error || ""}
								</p>
							))}
						</details>
					)}
					{d.nextAttempt && (
						<p>下次处理：{new Date(d.nextAttempt).toLocaleString()}</p>
					)}
					<a
						href={`/api/v1/deliveries/${encodeURIComponent(d.mailbox)}/${d.id}/original`}
					>
						下载原始 EML
					</a>
					{["failed", "uncertain"].includes(d.state) && (
						<button className="ml-4" onClick={() => retry(d)}>
							核对后重试
						</button>
					)}
				</article>
			))}
			{cursor && <button onClick={() => setCursor("")}>回到首页</button>}
			{data?.cursor && (
				<button onClick={() => setCursor(data.cursor!)}>下一页</button>
			)}
		</main>
	);
}
