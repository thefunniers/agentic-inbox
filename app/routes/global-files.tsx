// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file.

import { Link } from "react-router";
import { CaretLeftIcon } from "@phosphor-icons/react";
import { mailboxDirectoryUrl } from "~/lib/mailbox-directory-location";
import FileBrowser from "~/components/FileBrowser";

export function meta() {
	return [{ title: "全局文件 · Agentic Inbox" }];
}

export default function GlobalFilesRoute() {
	return <div className="flex h-dvh flex-col overflow-hidden bg-kumo-base">
		<header className="shrink-0 border-b border-kumo-line px-4 py-3 md:px-6">
			<Link to={mailboxDirectoryUrl()} className="inline-flex items-center gap-1 text-sm text-kumo-subtle hover:text-kumo-default"><CaretLeftIcon size={16} />邮箱目录</Link>
		</header>
		<main className="mx-auto min-h-0 w-full max-w-5xl flex-1 border-x border-kumo-line"><FileBrowser /></main>
	</div>;
}
