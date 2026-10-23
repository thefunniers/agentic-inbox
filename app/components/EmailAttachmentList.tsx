// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { DownloadSimpleIcon, PaperclipIcon, FileIcon, ImageIcon } from "@phosphor-icons/react";
import { formatBytes, getAttachmentUrl } from "~/lib/utils";
import { isPreviewableImage } from "../../shared/attachments";
import type { Attachment } from "~/types";

interface EmailAttachmentListProps {
	mailboxId?: string;
	emailId: string;
	attachments?: Attachment[];
	onPreviewImage?: (url: string, filename: string) => void;
	className?: string;
	showHeading?: boolean;
}

export default function EmailAttachmentList({ mailboxId, emailId, attachments = [], onPreviewImage, className, showHeading = false }: EmailAttachmentListProps) {
	if (!mailboxId || !attachments.length) return null;
	return (
		<div className={className}>
			{showHeading && (
				<div className="flex items-center gap-2 mb-2">
					<PaperclipIcon size={14} className="text-kumo-subtle" />
					<span className="text-sm font-medium text-kumo-default">{attachments.length} attachment{attachments.length === 1 ? "" : "s"}</span>
				</div>
			)}
			<div className="flex flex-wrap gap-2">
				{attachments.map((file) => {
					const url = getAttachmentUrl(mailboxId, emailId, file.id);
					const downloadUrl = getAttachmentUrl(mailboxId, emailId, file.id, true);
					const previewable = isPreviewableImage(file.mimetype) && !!onPreviewImage;
					const content = <>
						{previewable ? <ImageIcon size={16} className="shrink-0 text-kumo-subtle" /> : <FileIcon size={16} className="shrink-0 text-kumo-subtle" />}
						<span className="min-w-0 flex-1 truncate font-medium" title={file.filename}>{file.filename}</span>
						<span className="shrink-0 text-xs text-kumo-subtle">{formatBytes(file.size)}</span>
					</>;
					return (
						<div key={file.id} className="flex items-center max-w-full rounded-md border border-kumo-line text-sm">
							{previewable ? (
								<button type="button" onClick={() => onPreviewImage!(url, file.filename)} className="flex min-w-0 items-center gap-2 p-3 text-left hover:bg-kumo-tint" aria-label={`Preview ${file.filename}`}>{content}</button>
							) : (
								<a href={downloadUrl} download={file.filename} className="flex min-w-0 items-center gap-2 p-3 no-underline hover:bg-kumo-tint" aria-label={`Download ${file.filename}`}>{content}</a>
							)}
							{previewable && <a href={downloadUrl} download={file.filename} className="shrink-0 border-l border-kumo-line p-3 hover:bg-kumo-tint" aria-label={`Download ${file.filename}`} title={`Download ${file.filename}`}><DownloadSimpleIcon size={16} /></a>}
						</div>
					);
				})}
			</div>
		</div>
	);
}
