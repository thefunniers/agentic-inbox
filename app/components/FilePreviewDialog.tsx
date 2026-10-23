// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file.

import { Banner, Button, Dialog, Loader } from "@cloudflare/kumo";
import { DownloadSimpleIcon } from "@phosphor-icons/react";
import { lazy, Suspense, useEffect, useState } from "react";
import { getAttachmentUrl } from "../../shared/attachments";
import { getFilePreviewKind, MAX_FILE_PREVIEW_BYTES, MAX_TEXT_PREVIEW_BYTES, type MailboxFile } from "../../shared/files";
import { formatBytes } from "~/lib/utils";
import api from "~/services/api";

const PdfPreview = lazy(() => import("./PdfPreview"));

export default function FilePreviewDialog({ mailboxId, file, onClose }: {
	mailboxId: string;
	file: MailboxFile;
	onClose: () => void;
}) {
	const kind = getFilePreviewKind(file.mimetype);
	const tooLarge = file.size > MAX_FILE_PREVIEW_BYTES;
	const [preview, setPreview] = useState<{ blob: Blob; url?: string; text?: string } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		if (!kind || tooLarge) return;
		const controller = new AbortController();
		let objectUrl: string | undefined;
		setError(null);
		setPreview(null);
		void (async () => {
			try {
				const blob = await api.getAttachment(mailboxId, file.email_id, file.id, controller.signal);
				if (blob.size > MAX_FILE_PREVIEW_BYTES) throw new Error("File exceeds preview limit");
				const text = kind === "text" ? await blob.slice(0, MAX_TEXT_PREVIEW_BYTES).text() : undefined;
				if (controller.signal.aborted) return;
				if (kind === "image") objectUrl = URL.createObjectURL(blob);
				setPreview({ blob, url: objectUrl, text });
			} catch {
				if (!controller.signal.aborted) setError("无法加载附件。请重试，或下载原文件查看。");
			}
		})();
		return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
	}, [mailboxId, file.email_id, file.id, kind, tooLarge, attempt]);

	return <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
		<Dialog size="lg" className="p-4 sm:p-5" style={{ width: "min(48rem, calc(100vw - 2rem))", minWidth: 0 }}>
			<Dialog.Title><span className="block break-all pr-6">{file.filename}</span></Dialog.Title>
			<p className="mt-2 break-all text-xs text-kumo-subtle">{formatBytes(file.size)} · {mailboxId}</p>
			<div className="mt-4 min-h-40 min-w-0 max-h-[65dvh] overflow-auto rounded-md border border-kumo-line bg-kumo-tint/30 p-3">
				{!kind || tooLarge ? <div className="px-2 py-10 text-center text-sm text-kumo-subtle">{tooLarge ? "文件较大，请下载后查看。" : "此格式暂不支持在线预览，请下载后打开。"}</div>
					: error ? <div role="alert"><Banner variant="error" text={error} /><Button className="mt-3" variant="secondary" size="sm" onClick={() => setAttempt((value) => value + 1)}>重新加载</Button></div>
						: !preview ? <div role="status" className="flex items-center justify-center gap-2 py-12 text-sm text-kumo-subtle"><Loader />正在加载预览</div>
							: kind === "image" ? <img src={preview.url} alt={file.filename} className="mx-auto max-h-[58dvh] max-w-full object-contain" onError={() => setError("图片无法预览，请下载原文件查看。")} />
								: kind === "pdf" ? <Suspense fallback={<div role="status" className="p-8 text-center"><Loader />正在加载 PDF</div>}><PdfPreview blob={preview.blob} /></Suspense>
									: <><pre className="whitespace-pre-wrap break-words text-xs leading-relaxed text-kumo-default">{preview.text || "（空文件）"}</pre>{preview.blob.size > MAX_TEXT_PREVIEW_BYTES && <p className="mt-4 text-xs text-kumo-subtle">已显示前 200 KB，下载可查看完整内容。</p>}</>}
			</div>
			<div className="mt-4 flex items-center justify-between gap-3">
				<a href={getAttachmentUrl(mailboxId, file.email_id, file.id, true)} download={file.filename} className="inline-flex items-center gap-2 rounded-md border border-kumo-line px-3 py-2 text-sm text-kumo-default hover:bg-kumo-tint"><DownloadSimpleIcon size={16} />下载原文件</a>
				<Button variant="secondary" onClick={onClose}>关闭</Button>
			</div>
		</Dialog>
	</Dialog.Root>;
}
