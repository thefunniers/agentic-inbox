// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file.

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { FileListOptions, GlobalFileListPage } from "../../shared/files";
import api from "~/services/api";
import { queryKeys } from "./keys";

export function useFiles(mailboxId: string | undefined, options: FileListOptions, mailboxFilter?: string) {
	const qc = useQueryClient();
	const load = async (input: FileListOptions, signal?: AbortSignal): Promise<GlobalFileListPage> => {
			if (!mailboxId) return api.listGlobalFiles(input, mailboxFilter, signal);
			const result = await api.listFiles(mailboxId, input, signal);
			return { ...result, files: result.files.map((file) => ({ ...file, mailboxId })), mailboxCount: 1 };
	};
	const query = useQuery<GlobalFileListPage>({
		queryKey: queryKeys.files.list(mailboxId || mailboxFilter || "_all", options),
		queryFn: ({ signal }) => load(options, signal),
		staleTime: 15_000,
		refetchInterval: (query) => query.state.data?.index?.state === "building" ? 2000 : 15_000,
	});
	const nextCursor = query.data?.nextCursor;
	const nextPage = (query.data?.page ?? options.page) + 1;
	const ready = query.data?.index?.state === "ready";
	useEffect(() => {
		if (!nextCursor || !ready) return;
		const next = { ...options, page: nextPage, cursor: nextCursor };
		void qc.prefetchQuery({
			queryKey: queryKeys.files.list(mailboxId || mailboxFilter || "_all", next),
			queryFn: ({ signal }) => load(next, signal), staleTime: 15_000,
		});
	}, [nextCursor, nextPage, ready, mailboxId, mailboxFilter, options.q, options.direction, options.includeInline, options.limit, qc]);
	return query;
}
