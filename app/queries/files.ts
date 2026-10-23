// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file.

import { useQuery } from "@tanstack/react-query";
import type { FileListOptions, GlobalFileListPage } from "../../shared/files";
import api from "~/services/api";
import { queryKeys } from "./keys";

export function useFiles(mailboxId: string | undefined, options: FileListOptions, mailboxFilter?: string) {
	return useQuery<GlobalFileListPage>({
		queryKey: queryKeys.files.list(mailboxId || mailboxFilter || "_all", options),
		queryFn: async ({ signal }) => {
			if (!mailboxId) return api.listGlobalFiles(options, mailboxFilter, signal);
			const result = await api.listFiles(mailboxId, options, signal);
			return { ...result, files: result.files.map((file) => ({ ...file, mailboxId })), mailboxCount: 1 };
		},
		refetchInterval: mailboxId ? 30_000 : 60_000,
	});
}
