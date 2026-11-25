import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import {
	deliveryMode,
	type Delivery,
	type DeliveryMode,
} from "../../workers/backup/model";

function stateLabel(d: Delivery) {
	const mode = deliveryMode(d);
	if (d.state === "submitted")
		return mode === "forward" ? "已提交原样转发" : "已提交发送（通知副本）";
	const labels = {
		pending: "待处理",
		retrying: "自动重试中",
		failed: "失败，需处理",
		uncertain: "发送结果未知，需核对",
	};
	return labels[d.state];
}

const historyLabels = {
	pending: "待处理",
	retrying: "自动重试中",
	submitted: "已提交",
	failed: "失败",
	uncertain: "结果未知",
};

function csvCell(value: unknown) {
	const text = String(value ?? "");
	return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export default function Deliveries() {
	const [attention, setAttention] = useState(true);
	const [modeFilter, setModeFilter] = useState<"" | DeliveryMode>("");
	const [cursor, setCursor] = useState("");
	const [error, setError] = useState("");
	const [exporting, setExporting] = useState(false);
	const { data, refetch, isLoading, isError } = useQuery({
		queryKey: ["deliveries", cursor, attention, modeFilter],
		queryFn: async () => {
			const params = new URLSearchParams({
				attention: String(attention),
				cursor,
			});
			if (modeFilter) params.set("mode", modeFilter);
			const r = await fetch(`/api/v1/deliveries?${params.toString()}`);
			if (!r.ok) throw new Error("无法加载投递记录");
			return r.json() as Promise<{
				deliveries: Delivery[];
				cursor: string | null;
			}>;
		},
		refetchInterval: 10000,
	});

	async function retry(d: Delivery) {
		const isInboxOnly = Boolean(d.backupDelivered && !d.inboxStored);
		const isForwardFallback = !isInboxOnly && deliveryMode(d) === "forward";
		const prompt = isInboxOnly
			? "此邮件已提交转发，继续操作仅重试保存到 Inbox，不会重复发信。是否继续？"
			: isForwardFallback
				? "原样转发已无法二次触发。继续操作会改用通知副本（附 original.eml）补发到目标邮箱。请先核对目标邮箱未收到原信，是否继续？"
				: "请先核对目标邮箱，确认未收到此副本。继续重试可能产生重复邮件，是否继续？";
		if (!window.confirm(prompt)) return;
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

	async function exportNotifications(format: "json" | "csv") {
		setExporting(true);
		setError("");
		try {
			const all: Delivery[] = [];
			let next: string | null = "";
			while (next !== null) {
				const params = new URLSearchParams({
					attention: "false",
					mode: "notification",
					cursor: next,
				});
				const r = await fetch(`/api/v1/deliveries?${params.toString()}`);
				if (!r.ok) throw new Error("导出列表加载失败");
				const page = (await r.json()) as {
					deliveries: Delivery[];
					cursor: string | null;
				};
				all.push(...page.deliveries);
				next = page.cursor;
			}
			all.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
			const content =
				format === "json"
					? JSON.stringify(
							{
								exportedAt: new Date().toISOString(),
								totalCount: all.length,
								items: all.map((d) => ({
									id: d.id,
									receivedAt: d.receivedAt,
									mailbox: d.mailbox,
									sender: d.sender,
									subject: d.subject,
									target: d.target,
									state: d.state,
									attempts: d.attempts,
									inboxStored: d.inboxStored,
									originalMessageId: d.originalMessageId,
									fallbackFrom: d.fallbackFrom || null,
								})),
							},
							null,
							2,
						)
					: [
							[
								"receivedAt",
								"mailbox",
								"sender",
								"subject",
								"target",
								"state",
								"attempts",
								"inboxStored",
								"fallbackFrom",
								"originalMessageId",
								"id",
							].join(","),
							...all.map((d) =>
								[
									d.receivedAt,
									d.mailbox,
									d.sender,
									d.subject,
									d.target,
									d.state,
									d.attempts,
									d.inboxStored,
									d.fallbackFrom || "",
									d.originalMessageId || "",
									d.id,
								]
									.map(csvCell)
									.join(","),
							),
						].join("\n");
			const blob = new Blob([content], {
				type:
					format === "json"
						? "application/json;charset=utf-8"
						: "text/csv;charset=utf-8",
			});
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `notification-deliveries-${new Date().toISOString().slice(0, 10)}.${format}`;
			a.click();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
		} catch (e) {
			setError(e instanceof Error ? e.message : "导出失败，请重试。");
		} finally {
			setExporting(false);
		}
	}

	return (
		<main className="max-w-3xl mx-auto p-5 space-y-4">
			<Link to="/">返回邮箱目录</Link>
			<h1 className="text-xl font-bold">来信副本投递</h1>
			<p>
				当前默认使用原样转发到目标邮箱，保留原发件人、正文、附件与收信链；转发失败时保留原始
				EML 并在本页告警，核对后可下载原文或手动发送通知副本回退。“已提交”仅表示平台已接受，请同时关注目标邮箱的垃圾箱。
			</p>
			<p role="alert">
				{error || (isError ? "无法加载投递记录，请重试。" : "")}
			</p>
			<div className="flex flex-wrap items-center gap-3">
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
				</label>
				<label>
					模式：
					<select
						value={modeFilter}
						onChange={(e) => {
							setModeFilter(e.target.value as "" | DeliveryMode);
							setCursor("");
						}}
						className="border rounded px-2 py-1 ml-1"
					>
						<option value="">全部</option>
						<option value="forward">原样转发</option>
						<option value="notification">通知副本</option>
					</select>
				</label>
				<button onClick={() => refetch()}>刷新</button>
				<button
					disabled={exporting}
					onClick={() => exportNotifications("csv")}
				>
					{exporting ? "导出中…" : "导出通知副本清单 CSV"}
				</button>
				<button
					disabled={exporting}
					onClick={() => exportNotifications("json")}
				>
					导出 JSON
				</button>
			</div>
			{isLoading && <p>加载中…</p>}
			{data?.deliveries.length === 0 && (
				<p>暂无副本投递记录。历史邮件不会自动补发。</p>
			)}
			{data?.deliveries.map((d) => {
				const mode = deliveryMode(d);
				const isInboxOnly = Boolean(d.backupDelivered && !d.inboxStored);
				return (
					<article
						key={d.id}
						className="border rounded p-4 space-y-2 break-words"
					>
						<div className="flex flex-wrap items-center gap-2">
							<strong>{d.subject}</strong>
							<span className="text-xs border rounded px-2 py-0.5">
								{mode === "forward"
									? "原样转发"
									: d.fallbackFrom === "forward"
										? "通知副本（转发回退）"
										: "通知副本"}
							</span>
						</div>
						<p>学生邮箱：{d.mailbox}</p>
						<p>原发件人：{d.sender}</p>
						<p>目标邮箱：{d.target}</p>
						<p>收信时间：{new Date(d.receivedAt).toLocaleString()}</p>
						<p
							role={
								["failed", "uncertain", "retrying"].includes(d.state)
									? "alert"
									: undefined
							}
						>
							{stateLabel(d)} · 已尝试 {d.attempts} 次 ·{" "}
							{d.inboxStored ? "Inbox 已保存" : "Inbox 尚未保存"}
						</p>
						{d.error && <p>{d.error}</p>}
						{d.history && (
							<details>
								<summary>处理记录</summary>
								{d.history.map((h, i) => (
									<p key={i}>
										{new Date(h.at).toLocaleString()} ·{" "}
										{historyLabels[h.state]} · 第 {h.attempts} 次{" "}
										{h.error || ""}
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
								{isInboxOnly
									? "仅重试入库 Inbox"
									: mode === "forward"
										? "核对后发回退副本"
										: "核对后重试"}
							</button>
						)}
					</article>
				);
			})}
			{cursor && <button onClick={() => setCursor("")}>回到首页</button>}
			{data?.cursor && (
				<button onClick={() => setCursor(data.cursor!)}>下一页</button>
			)}
		</main>
	);
}
