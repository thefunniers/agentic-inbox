// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file.

import FileBrowser from "~/components/FileBrowser";

export function meta() {
	return [{ title: "文件 · Agentic Inbox" }];
}

export default function FilesRoute() {
	return <FileBrowser />;
}
