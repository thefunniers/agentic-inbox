// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file.

import { Banner, Button, Loader } from "@cloudflare/kumo";
import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions, version, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

export default function PdfPreview({ blob }: { blob: Blob }) {
	const container = useRef<HTMLDivElement>(null);
	const canvas = useRef<HTMLCanvasElement>(null);
	const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
	const [page, setPage] = useState(1);
	const [width, setWidth] = useState(0);
	const [rendering, setRendering] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		let loading: ReturnType<typeof getDocument> | undefined;
		void (async () => {
			try {
				const bytes = await blob.arrayBuffer();
				if (cancelled) return;
				const assets = `/pdfjs/${version}/`;
				loading = getDocument({ data: bytes,
					cMapUrl: `${assets}cmaps/`, standardFontDataUrl: `${assets}standard_fonts/`,
					wasmUrl: `${assets}wasm/`, iccUrl: `${assets}iccs/` });
				const pdf = await loading.promise;
				if (!cancelled) setDocument(pdf);
			} catch (cause) {
				if (!cancelled) setError(cause instanceof Error && cause.name === "PasswordException"
					? "此 PDF 需要密码，请下载后打开。" : "PDF 无法预览，请下载原文件查看。");
			}
		})();
		return () => { cancelled = true; void loading?.destroy(); };
	}, [blob]);

	useEffect(() => {
		const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
		if (container.current) observer.observe(container.current);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		if (!document || !canvas.current || !width) return;
		let cancelled = false;
		let task: RenderTask | undefined;
		setRendering(true);
		void (async () => {
			try {
				const pdfPage = await document.getPage(page);
				if (cancelled || !canvas.current) return;
				const natural = pdfPage.getViewport({ scale: 1 });
				const viewport = pdfPage.getViewport({ scale: Math.min(width / natural.width, 4096 / natural.height) });
				const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
				canvas.current.width = Math.ceil(viewport.width * pixelRatio);
				canvas.current.height = Math.ceil(viewport.height * pixelRatio);
				canvas.current.style.width = `${viewport.width}px`;
				canvas.current.style.height = `${viewport.height}px`;
				task = pdfPage.render({ canvas: canvas.current, viewport,
					transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0] });
				await task.promise;
				if (!cancelled) setRendering(false);
			} catch {
				if (!cancelled) setError("这一页无法预览，请下载原文件查看。");
			}
		})();
		return () => { cancelled = true; task?.cancel(); };
	}, [document, page, width]);

	return <div ref={container} className="min-w-0">
		{error ? <Banner variant="error" text={error} /> : <>
			<div className="sticky top-0 z-10 mb-3 flex items-center justify-center gap-3 rounded-md bg-kumo-base p-2 text-xs">
				<Button size="sm" variant="ghost" shape="square" aria-label="PDF 上一页" icon={<CaretLeftIcon size={16} />} disabled={!document || page <= 1 || rendering} onClick={() => setPage((value) => value - 1)} />
				<span>{document ? `${page} / ${document.numPages}` : "加载 PDF…"}</span>
				<Button size="sm" variant="ghost" shape="square" aria-label="PDF 下一页" icon={<CaretRightIcon size={16} />} disabled={!document || page >= document.numPages || rendering} onClick={() => setPage((value) => value + 1)} />
			</div>
			{rendering && <div role="status" className="flex justify-center py-4"><Loader /><span className="sr-only">正在渲染 PDF</span></div>}
			<canvas ref={canvas} aria-label={`PDF 第 ${page} 页`} className={`mx-auto max-w-full bg-white ${rendering ? "invisible" : ""}`} />
		</>}
	</div>;
}
