import { Button } from "@cloudflare/kumo";
import { FileIcon, PaperclipIcon, XIcon } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { formatBytes } from "~/lib/utils";
import type { ComposeAttachment } from "~/lib/compose-attachments";

interface Props {
	attachments: ComposeAttachment[];
	onAdd: (files: File[]) => void;
	onRemove: (id: string) => void;
	busy: boolean;
	reading: boolean;
}

export default function ComposeAttachments({ attachments, onAdd, onRemove, busy, reading }: Props) {
	const input = useRef<HTMLInputElement>(null);
	const [dragging, setDragging] = useState(false);
	return (
		<div
			className={`rounded-md border border-dashed p-3 space-y-2 transition-colors ${dragging ? "border-kumo-brand bg-kumo-tint" : "border-kumo-line"}`}
			onDragOver={(event) => {
				if (!event.dataTransfer.types.includes("Files")) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = busy ? "none" : "copy";
				if (!busy) setDragging(true);
			}}
			onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
			onDrop={(event) => {
				event.preventDefault(); setDragging(false);
				if (!busy) onAdd(Array.from(event.dataTransfer.files));
			}}
		>
			<div className="flex flex-wrap items-center gap-2">
				<input ref={input} type="file" multiple className="sr-only" aria-label="Choose attachments" disabled={busy}
					onChange={(event) => { onAdd(Array.from(event.target.files || [])); event.target.value = ""; }} />
				<Button type="button" variant="secondary" size="sm" icon={<PaperclipIcon size={16} />}
					disabled={busy} loading={reading} onClick={() => input.current?.click()}>
					{reading ? "Reading files..." : "Attach files"}
				</Button>
				<span className="text-xs text-kumo-subtle">or drop files here</span>
			</div>
			<p className="text-xs text-kumo-subtle">Up to 32 files. Email size limit: 5 MiB, including encoding and message.</p>
			{attachments.length > 0 && (
				<ul className="space-y-2" aria-label="Attachments">
					{attachments.map((file) => (
						<li key={file.id} className="flex items-center gap-2 rounded border border-kumo-line bg-kumo-base px-2 py-1.5 text-sm">
							<FileIcon size={16} className="shrink-0 text-kumo-subtle" />
							<span className="min-w-0 flex-1 truncate" title={file.filename}>{file.filename}</span>
							<span className="shrink-0 text-xs text-kumo-subtle">{formatBytes(file.size)}</span>
							<Button type="button" variant="ghost" shape="square" size="sm" disabled={busy}
								aria-label={`Remove ${file.filename}`} icon={<XIcon size={14} />} onClick={() => onRemove(file.id)} />
						</li>
					))}
				</ul>
			)}
			{attachments.length > 0 && <p className="text-xs text-kumo-subtle">{attachments.length} file{attachments.length === 1 ? "" : "s"} · {formatBytes(attachments.reduce((size, file) => size + file.size, 0))}</p>}
		</div>
	);
}
