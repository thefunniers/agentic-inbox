// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file.

import { Banner, Button, Input, Loader } from "@cloudflare/kumo";
import { ArrowClockwiseIcon, ArrowDownLeftIcon, ArrowUpRightIcon, CaretLeftIcon, CaretRightIcon, DownloadSimpleIcon, FileIcon, FilePdfIcon, FileTextIcon, FilesIcon, ImageIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { getFilePreviewKind, type FileDirection, type MailboxFile, type GlobalFile } from "../../shared/files";
import { getAttachmentUrl } from "../../shared/attachments";
import FilePreviewDialog from "~/components/FilePreviewDialog";
import MailboxSplitView from "~/components/MailboxSplitView";
import { useUIStore } from "~/hooks/useUIStore";
import { formatBytes } from "~/lib/utils";
import { useFiles } from "~/queries/files";
import { useMailboxes } from "~/queries/mailboxes";

const directions: { value: FileDirection; label: string }[] = [
	{ value: "all", label: "全部" },
	{ value: "received", label: "收到" },
	{ value: "sent", label: "发出" },
];

function FileSymbol({ file }: { file: MailboxFile }) {
	const kind = getFilePreviewKind(file.mimetype);
	const Icon = kind === "image" ? ImageIcon : kind === "pdf" ? FilePdfIcon : kind === "text" ? FileTextIcon : FileIcon;
	return <Icon size={24} className="text-kumo-subtle" />;
}

function fileDate(value: string | null) {
	if (!value) return "日期未知";
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? "日期未知" : date.toLocaleString("zh-CN", {
		year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
	});
}

export default function FileBrowser() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const navigate = useNavigate();
	const [searchParams, setSearchParams] = useSearchParams();
	const mailboxFilter = mailboxId ? undefined : searchParams.get("mailbox") || undefined;
	const { data: mailboxes, isError: mailboxError } = useMailboxes(!mailboxId);
	const q = searchParams.get("q")?.trim().slice(0, 320) || "";
	const direction: FileDirection = searchParams.get("direction") === "sent" ? "sent"
		: searchParams.get("direction") === "received" ? "received" : "all";
	const includeInline = searchParams.get("includeInline") === "true";
	const requestedPage = Number(searchParams.get("page") || 1);
	const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
	const cursor = searchParams.get("cursor") || undefined;
	const pageCursors = useRef(new Map<string, string>());
	const filterKey = JSON.stringify([mailboxId, mailboxFilter, q, direction, includeInline]);
	const [searchInput, setSearchInput] = useState(q);
	const [previewFile, setPreviewFile] = useState<GlobalFile | null>(null);
	const { selectedEmailId, isComposing, selectEmail, closePanel } = useUIStore();
	const { data, isPending, isError, isFetching, refetch } = useFiles(mailboxId, { page, limit: 25, q, direction, includeInline, cursor }, mailboxFilter);
	const currentPage = data?.page || page;
	const totalPages = data?.totalPages || 1;
	const files = data?.files || [];
	const building = data?.index?.state === "building";
	useEffect(() => {
		pageCursors.current.set(`${filterKey}:${page}`, cursor || "");
		if (data?.nextCursor) pageCursors.current.set(`${filterKey}:${data.page + 1}`, data.nextCursor);
	}, [filterKey, page, cursor, data]);

	useEffect(() => setSearchInput(q), [q]);
	useEffect(() => { closePanel(); setPreviewFile(null); }, [mailboxId, closePanel]);
	useEffect(() => {
		if (data && data.page !== page) {
			setSearchParams((previous) => {
				const next = new URLSearchParams(previous);
				next.set("page", String(data.page));
				next.delete("cursor");
				return next;
			}, { replace: true });
		}
	}, [data, page, setSearchParams]);

	const updateFilters = (values: Record<string, string>) => {
		setSearchParams((previous) => {
			const next = new URLSearchParams(previous);
			next.delete("page");
			next.delete("cursor");
			for (const [key, value] of Object.entries(values)) {
				if (value) next.set(key, value);
				else next.delete(key);
			}
			return next;
		});
	};
	useEffect(() => {
		if (searchInput.trim() === q) return;
		const timer = setTimeout(() => updateFilters({ q: searchInput.trim() }), 300);
		return () => clearTimeout(timer);
	}, [searchInput, q]);
	const search = (event: FormEvent) => {
		event.preventDefault();
		updateFilters({ q: searchInput.trim() });
	};
	const openEmail = (file: GlobalFile) => {
		if (mailboxId) selectEmail(file.email_id);
		else navigate(`/mailbox/${encodeURIComponent(file.mailboxId)}/emails/${encodeURIComponent(file.folder_id)}?email=${encodeURIComponent(file.email_id)}`);
	};

	return (
		<>
			<MailboxSplitView selectedEmailId={mailboxId ? selectedEmailId : null} isComposing={!!mailboxId && isComposing}>
				<div className="shrink-0 border-b border-kumo-line px-4 py-4 md:px-5">
					<div className="flex items-start justify-between gap-3">
						<div className="min-w-0">
							<h1 className="text-xl font-semibold text-kumo-default">{mailboxId ? "文件" : "全局文件"}</h1>
							<p className="mt-1 text-sm text-kumo-subtle">{mailboxId ? "集中查看这个邮箱收到和发出的附件" : "集中查看所有邮箱的收发附件，也可按邮箱筛选"}</p>
							{mailboxId && <Link to="/files" className="mt-2 inline-block text-xs text-kumo-link hover:underline">查看全局文件 →</Link>}
						</div>
						<Button variant="ghost" shape="square" icon={<ArrowClockwiseIcon size={18} className={isFetching ? "animate-spin" : ""} />} aria-label="刷新文件" disabled={isFetching} onClick={() => void refetch()} />
					</div>
					{!mailboxId && <label className="mt-4 flex items-center gap-3 text-sm text-kumo-subtle">
						<span className="shrink-0">邮箱</span>
						<select aria-label="按邮箱筛选" value={mailboxFilter || ""} onChange={(event) => updateFilters({ mailbox: event.target.value })} className="min-w-0 flex-1 rounded-md border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default md:max-w-md">
							<option value="">全部邮箱</option>
							{mailboxFilter && !mailboxes?.some((mailbox) => mailbox.id === mailboxFilter) && <option value={mailboxFilter}>{mailboxFilter}</option>}
							{mailboxes?.slice().sort((a, b) => a.email.localeCompare(b.email)).map((mailbox) => <option key={mailbox.id} value={mailbox.id}>{mailbox.email}</option>)}
						</select>
					</label>}
					{!mailboxId && mailboxError && <p role="alert" className="mt-2 text-xs text-kumo-danger">邮箱筛选列表暂时无法加载，请刷新页面重试。</p>}
					<form onSubmit={search} className="mt-4 flex gap-2">
						<Input className="min-w-0 flex-1" aria-label="搜索文件" placeholder="文件名、邮件主题或邮箱地址" value={searchInput} maxLength={320} onChange={(event) => setSearchInput(event.target.value)} />
						<Button type="submit" variant="secondary" shape="square" icon={<MagnifyingGlassIcon size={18} />} aria-label="搜索附件" />
					</form>
					<div className="mt-3 flex flex-wrap items-center justify-between gap-3">
						<div className="flex gap-1" role="group" aria-label="收发筛选">
							{directions.map((item) => <Button key={item.value} size="sm" variant={direction === item.value ? "secondary" : "ghost"} aria-pressed={direction === item.value} onClick={() => updateFilters({ direction: item.value === "all" ? "" : item.value })}>{item.label}</Button>)}
						</div>
						<label className="flex items-center gap-2 text-xs text-kumo-subtle cursor-pointer">
							<input type="checkbox" checked={includeInline} onChange={(event) => updateFilters({ includeInline: event.target.checked ? "true" : "" })} />
							包含正文图片
						</label>
					</div>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto" aria-busy={isFetching}>
					{building && <p role="status" className="px-5 pt-4 text-sm text-kumo-subtle">正在整理历史附件，列表会自动更新。已整理 {data?.index?.completedMailboxes} / {data?.index?.discoveredMailboxes} 个邮箱。</p>}
					{isPending ? <div className="flex justify-center p-12" role="status"><Loader /> <span className="sr-only">正在加载文件</span></div>
						: isError ? <div className="p-5"><Banner variant="error" text="文件列表加载失败，请重试。" /><Button className="mt-3" variant="secondary" onClick={() => void refetch()}>重试</Button></div>
							: files.length === 0 ? <div className="flex flex-col items-center px-5 py-16 text-center">
								<FilesIcon size={36} className="text-kumo-subtle" />
								<h2 className="mt-4 text-base font-medium text-kumo-default">{building ? "正在整理附件" : q || direction !== "all" ? "没有匹配的附件" : "还没有附件"}</h2>
								<p className="mt-2 text-sm text-kumo-subtle">{q || direction !== "all" ? "试试其他关键词，或查看全部文件。" : "收发邮件中的附件会显示在这里。"}</p>
								<p className="mt-1 text-xs text-kumo-subtle">草稿和垃圾箱中的附件不在此列表中。</p>
								{(q || direction !== "all") && <Button className="mt-4" variant="secondary" onClick={() => updateFilters({ q: "", direction: "" })}>清除筛选</Button>}
							</div> : <ul className="divide-y divide-kumo-line" aria-label="附件列表">
								{files.map((file) => <li key={`${file.mailboxId}/${file.id}`} className="px-4 py-4 md:px-5 hover:bg-kumo-tint/30">
									<div className="flex items-start gap-3">
										<div className="shrink-0 rounded-lg bg-kumo-tint p-2.5"><FileSymbol file={file} /></div>
										<div className="min-w-0 flex-1">
											<button type="button" className="block max-w-full truncate text-left text-sm font-semibold text-kumo-default hover:underline" title={file.filename} aria-label={`预览 ${file.filename}`} onClick={() => setPreviewFile(file)}>{file.filename}</button>
											<div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-kumo-subtle">
												<span>{formatBytes(file.size)}</span><span>·</span><span>{fileDate(file.date)}</span>
												{file.disposition?.toLowerCase() === "inline" && <span className="rounded bg-kumo-tint px-1.5 py-0.5">正文图片</span>}
											</div>
											<div className="mt-2 flex min-w-0 items-center gap-1.5 text-xs text-kumo-subtle">
												<span className="flex shrink-0 items-center gap-1">{file.direction === "sent" ? <ArrowUpRightIcon size={13} /> : <ArrowDownLeftIcon size={13} />}{file.direction === "sent" ? "发给" : "来自"}</span>
												<span className="truncate" title={(file.direction === "sent" ? file.recipient : file.sender) || ""}>{(file.direction === "sent" ? file.recipient : file.sender) || "未知地址"}</span>
											</div>
												{!mailboxId && <Link to={`/mailbox/${encodeURIComponent(file.mailboxId)}/files`} className="mt-1 block truncate text-xs text-kumo-subtle hover:underline" title={file.mailboxId}>邮箱：{file.mailboxId}</Link>}
												<button type="button" className="mt-1 block max-w-full truncate text-left text-xs text-kumo-link hover:underline" title={file.subject || "无主题"} aria-label={`查看邮件：${file.subject || "无主题"}`} onClick={() => openEmail(file)}>{file.subject || "无主题"}</button>
										</div>
										<a className="shrink-0 rounded-md p-2 text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default" href={getAttachmentUrl(file.mailboxId, file.email_id, file.id, true)} download={file.filename} title="下载" aria-label={`下载 ${file.filename}`}><DownloadSimpleIcon size={20} /></a>
									</div>
								</li>)}
							</ul>}
				</div>
				{data && !isError && <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-kumo-line px-4 py-3 text-xs text-kumo-subtle">
					<span role="status">{building ? "已找到" : "共"} {data.totalCount} 个文件{!mailboxId && ` · ${data.mailboxCount} 个邮箱`}</span>
					<div className="flex items-center gap-2">
						<Button variant="ghost" size="sm" shape="square" aria-label="上一页" icon={<CaretLeftIcon size={16} />} disabled={currentPage <= 1 || isFetching} onClick={() => updateFilters({ page: String(currentPage - 1), cursor: pageCursors.current.get(`${filterKey}:${currentPage - 1}`) || "" })} />
						<span>{currentPage} / {totalPages}</span>
						<Button variant="ghost" size="sm" shape="square" aria-label="下一页" icon={<CaretRightIcon size={16} />} disabled={currentPage >= totalPages || isFetching} onClick={() => updateFilters({ page: String(currentPage + 1), cursor: data.nextCursor || "" })} />
					</div>
				</div>}
			</MailboxSplitView>
			{previewFile && <FilePreviewDialog key={`${previewFile.mailboxId}/${previewFile.id}`} mailboxId={previewFile.mailboxId} file={previewFile} onClose={() => setPreviewFile(null)} />}
		</>
	);
}
