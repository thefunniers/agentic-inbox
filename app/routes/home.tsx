// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	Button,
	Dialog,
	Input,
	Loader,
	Select,
	Text,
	useKumoToastManager,
} from "@cloudflare/kumo";
import {
	ArrowClockwiseIcon,
	CaretLeftIcon,
	CaretRightIcon,
	CopyIcon,
	EnvelopeIcon,
	FilesIcon,
	MagnifyingGlassIcon,
	PlusIcon,
	TrashIcon,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link as RouterLink, useSearchParams } from "react-router";
import api from "~/services/api";
import {
	useCreateMailbox,
	useDeleteMailbox,
	useMailboxDirectory,
	useMailboxes,
} from "~/queries/mailboxes";
import { queryKeys } from "~/queries/keys";
import { rememberMailboxDirectory } from "~/lib/mailbox-directory-location";

export function meta() {
	return [{ title: "邮箱目录 · Agentic Inbox" }];
}

export default function HomeRoute() {
	const toastManager = useKumoToastManager();
	const createMailbox = useCreateMailbox();
	const deleteMailbox = useDeleteMailbox();
	const [searchParams, setSearchParams] = useSearchParams();
	const urlQuery = searchParams.get("q")?.trim() ?? "";
	const domain = searchParams.get("domain") ?? "";
	const requestedPage = Number(searchParams.get("page") ?? 1);
	const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
	const requestedLimit = Number(searchParams.get("limit") ?? 25);
	const limit = [25, 50, 100].includes(requestedLimit) ? requestedLimit : 25;
	const [searchInput, setSearchInput] = useState(urlQuery);

	const { data: configData, isError: configError, refetch: refetchConfig } = useQuery({
		queryKey: queryKeys.config,
		queryFn: () => api.getConfig(),
		staleTime: Infinity, // config rarely changes
	});

	const domains = configData?.domains ?? [];
	const emailAddresses = configData?.emailAddresses ?? [];
	const isConfigured = emailAddresses.length > 0;
	const { data: mailboxes = [], refetch: refetchMailboxes, isSuccess: mailboxesFetched } = useMailboxes(isConfigured);
	const { data: directory, isPending, isError: directoryError, isFetching, refetch } = useMailboxDirectory(
		{ page, limit, q: urlQuery, domain }, !!configData,
	);
	const accounts = directory?.mailboxes ?? [];
	const totalCount = directory?.totalCount ?? 0;
	const totalPages = directory?.totalPages ?? 1;
	const currentPage = directory?.page ?? page;
	const isLoading = !configData || isPending;
	const isError = configError || directoryError;

	useEffect(() => setSearchInput(urlQuery), [urlQuery]);
	useEffect(() => {
		const query = searchParams.toString();
		rememberMailboxDirectory(query ? `/?${query}` : "/");
	}, [searchParams]);
	useEffect(() => {
		if (directory && directory.page !== page) {
			setSearchParams((previous) => {
				const next = new URLSearchParams(previous);
				if (directory.page === 1) next.delete("page");
				else next.set("page", String(directory.page));
				return next;
			}, { replace: true });
		}
	}, [directory, page, setSearchParams]);

	const updateDirectory = (values: Record<string, string>) => {
		setSearchParams((previous) => {
			const next = new URLSearchParams(previous);
			next.delete("page");
			for (const [key, value] of Object.entries(values)) {
				if (value) next.set(key, value);
				else next.delete(key);
			}
			return next;
		});
	};

	const handleSearch = (event: FormEvent) => {
		event.preventDefault();
		updateDirectory({ q: searchInput.trim() });
	};
	const copyAddress = async (email: string) => {
		try {
			await navigator.clipboard.writeText(email);
			toastManager.add({ title: "邮箱地址已复制" });
		} catch {
			toastManager.add({ title: "复制失败，请选中地址手动复制", variant: "error" });
		}
	};

	const [isCreateOpen, setIsCreateOpen] = useState(false);
	const [newPrefix, setNewPrefix] = useState("");
	const [selectedDomain, setSelectedDomain] = useState("");
	const [newName, setNewName] = useState("");
	const [isCreating, setIsCreating] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);
	const [isDeleteOpen, setIsDeleteOpen] = useState(false);
	const [mailboxToDelete, setMailboxToDelete] = useState<{
		id: string;
		email: string;
	} | null>(null);
	const [isDeleting, setIsDeleting] = useState(false);

	// Set default domain when config loads
	useEffect(() => {
		if (domains.length > 0 && !selectedDomain) {
			setSelectedDomain(domains[0]);
		}
	}, [domains, selectedDomain]);

	// Auto-create mailboxes from config (run once when both data sources are ready)
	const autoCreateDone = useRef(false);
	useEffect(() => {
		if (autoCreateDone.current) return;
		if (emailAddresses.length === 0 || !mailboxesFetched) return;
		const existingEmails = new Set(
			mailboxes.map((m) => m.email.toLowerCase()),
		);
		const toCreate = emailAddresses.filter(
			(addr) => !existingEmails.has(addr.toLowerCase()),
		);
		if (toCreate.length === 0) {
			autoCreateDone.current = true;
			return;
		}
		autoCreateDone.current = true;
		let cancelled = false;
		Promise.all(
			toCreate.map((addr) => {
				const localPart = addr.split("@")[0] || addr;
				return api.createMailbox(addr, localPart).catch(() => {});
			}),
		).then(() => { if (!cancelled) refetchMailboxes(); });
		return () => { cancelled = true; };
	}, [emailAddresses, mailboxes, mailboxesFetched, refetchMailboxes]);

	const handleCreate = async (e: FormEvent) => {
		e.preventDefault();
		setCreateError(null);
		if (!newPrefix.trim() || !selectedDomain) {
			setCreateError("请填写邮箱地址并选择域名");
			return;
		}
		const email = `${newPrefix.trim().toLowerCase()}@${selectedDomain}`;
		const name = newName.trim() || newPrefix.trim();
		setIsCreating(true);
		try {
			await createMailbox.mutateAsync({ email, name });
			toastManager.add({ title: "邮箱已创建" });
			setIsCreateOpen(false);
			setNewPrefix("");
			setNewName("");
			setSearchInput(email);
			updateDirectory({ q: email, domain: "" });
		} catch (err: unknown) {
			const message = (err instanceof Error ? err.message : null) || "创建邮箱失败";
			setCreateError(message);
		} finally {
			setIsCreating(false);
		}
	};

	const handleDelete = async () => {
		if (!mailboxToDelete) return;
		setIsDeleting(true);
		try {
			await deleteMailbox.mutateAsync(mailboxToDelete.id);
			toastManager.add({ title: "邮箱已删除" });
			setIsDeleteOpen(false);
			setMailboxToDelete(null);
		} catch {
			toastManager.add({ title: "删除邮箱失败", variant: "error" });
		} finally {
			setIsDeleting(false);
		}
	};

	return (
		<div className="min-h-screen bg-kumo-recessed">
			<div className="mx-auto max-w-3xl px-4 py-8 md:px-6 md:py-12">
				<div className="mb-6">
					<div className="flex items-center justify-between gap-3">
						<h1 className="text-2xl font-bold text-kumo-default">邮箱目录</h1>
						<RouterLink to="/files" className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-md border border-kumo-line px-3 py-2 text-sm text-kumo-default hover:bg-kumo-tint"><FilesIcon size={16} />全局文件</RouterLink>
						{configData && !isConfigured && (
							<Button
								variant="primary"
								icon={<PlusIcon size={16} />}
								onClick={() => setIsCreateOpen(true)}
							>
								新建邮箱
							</Button>
						)}
					</div>
					<p className="text-sm text-kumo-subtle mt-2">按地址查找邮箱，打开后查看和处理邮件。</p>
				</div>

				<div className="mb-5 space-y-3">
					<form onSubmit={handleSearch} role="search" aria-label="搜索邮箱目录" className="flex gap-2">
						<Input
							className="min-w-0 flex-1"
							type="search"
							aria-label="搜索邮箱地址"
							placeholder="输入完整邮箱地址或其中一部分"
							value={searchInput}
							maxLength={320}
							onChange={(event) => setSearchInput(event.target.value)}
						/>
						<Button type="submit" variant="primary" icon={<MagnifyingGlassIcon size={16} />}>搜索</Button>
					</form>
					<div className="flex flex-wrap items-center gap-2">
						<Select aria-label="筛选邮箱域名" value={domain || "all"} renderValue={(value) => value === "all" ? "全部域名" : value} onValueChange={(value) => {
							if (value) updateDirectory({ domain: value === "all" ? "" : value });
						}}>
							<Select.Option value="all">全部域名</Select.Option>
							{domains.map((item) => <Select.Option key={item} value={item}>{item}</Select.Option>)}
						</Select>
						<Select aria-label="每页邮箱数量" value={String(limit)} renderValue={(value) => `每页 ${value} 个`} onValueChange={(value) => {
							if (value) updateDirectory({ limit: value === "25" ? "" : value });
						}}>
							{[25, 50, 100].map((size) => <Select.Option key={size} value={String(size)}>每页 {size} 个</Select.Option>)}
						</Select>
						<Button variant="ghost" size="sm" icon={<ArrowClockwiseIcon size={16} />} disabled={isFetching || !configData} onClick={() => void refetch()}>刷新目录</Button>
						{(urlQuery || domain) && <Button variant="ghost" size="sm" onClick={() => {
							setSearchInput("");
							updateDirectory({ q: "", domain: "" });
						}}>清除筛选</Button>}
					</div>
				</div>

				{isError ? (
					<div role="alert" className="rounded-xl border border-kumo-line bg-kumo-base p-8 text-center">
						<h2 className="font-semibold text-kumo-default">邮箱目录加载失败</h2>
						<p className="mt-2 text-sm text-kumo-subtle">暂时无法获取邮箱，请重试。</p>
						<Button className="mt-4" disabled={isFetching} onClick={() => { void refetchConfig(); void refetch(); }}>重新加载</Button>
					</div>
				) : isLoading ? (
					<div role="status" aria-label="正在加载邮箱目录" className="flex justify-center py-20">
						<Loader size="lg" />
					</div>
				) : (
					<>
						<p role="status" aria-live="polite" className="mb-3 text-sm text-kumo-subtle break-words">
							{urlQuery || domain ? "找到" : "共"} {totalCount} 个邮箱
							{accounts.length > 0 && ` · 当前显示 ${(currentPage - 1) * limit + 1}–${(currentPage - 1) * limit + accounts.length}`}
							{isFetching && " · 正在刷新…"}
						</p>
						{accounts.length > 0 ? (
							<ul className="rounded-xl border border-kumo-line bg-kumo-base divide-y divide-kumo-line overflow-hidden">
								{accounts.map((account) => (
									<li key={account.id} className="flex items-center gap-1 pr-2 md:pr-3 hover:bg-kumo-tint transition-colors">
										<RouterLink to={`/mailbox/${encodeURIComponent(account.id)}`} aria-label={`打开邮箱 ${account.email}`} className="flex min-w-0 flex-1 items-center gap-3 px-3 py-4 md:px-5 no-underline">
											<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-kumo-default"><EnvelopeIcon size={18} /></div>
											<div className="min-w-0 flex-1">
												<div className="text-sm font-medium text-kumo-default [overflow-wrap:anywhere]">
													{account.email.slice(0, account.email.lastIndexOf("@") + 1)}<wbr />{account.email.slice(account.email.lastIndexOf("@") + 1)}
												</div>
												<div className="mt-1 text-xs text-kumo-subtle">{account.email.slice(account.email.lastIndexOf("@") + 1)}</div>
											</div>
										</RouterLink>
										<Button variant="ghost" size="sm" shape="square" icon={<CopyIcon size={16} />} aria-label={`复制邮箱地址 ${account.email}`} onClick={() => void copyAddress(account.email)} />
										{!isConfigured && <Button variant="ghost" size="sm" shape="square" icon={<TrashIcon size={16} />} aria-label={`删除邮箱 ${account.email}`} onClick={() => {
											setMailboxToDelete({ id: account.id, email: account.email });
											setIsDeleteOpen(true);
										}} />}
									</li>
								))}
							</ul>
						) : (
							<div className="rounded-xl border border-kumo-line bg-kumo-base py-14 px-6 text-center">
								<EnvelopeIcon size={40} weight="thin" className="mx-auto mb-4 text-kumo-subtle" />
								<h2 className="font-semibold text-kumo-default">{urlQuery || domain ? "没有找到匹配的邮箱" : "还没有邮箱"}</h2>
								<p className="mt-2 text-sm text-kumo-subtle">{urlQuery || domain ? "试试更短的地址片段，或清除筛选条件。" : "收到新地址的邮件后，邮箱会自动出现在这里，也可以手动新建。"}</p>
							</div>
						)}
						{totalPages > 1 && (
							<nav aria-label="邮箱目录分页" className="mt-5 flex items-center justify-between gap-2">
								<Button variant="secondary" size="sm" icon={<CaretLeftIcon size={16} />} disabled={currentPage <= 1 || isFetching} onClick={() => updateDirectory({ page: currentPage === 2 ? "" : String(currentPage - 1) })}>上一页</Button>
								<span className="text-sm text-kumo-subtle">第 {currentPage} / {totalPages} 页</span>
								<Button variant="secondary" size="sm" disabled={currentPage >= totalPages || isFetching} onClick={() => updateDirectory({ page: String(currentPage + 1) })}>下一页<CaretRightIcon size={16} /></Button>
							</nav>
						)}
					</>
				)}
			</div>

			{/* Create Dialog */}
			<Dialog.Root open={isCreateOpen} onOpenChange={setIsCreateOpen}>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-5">
						新建邮箱
					</Dialog.Title>
					<form onSubmit={handleCreate} className="space-y-4">
						{createError && (
							<Text variant="error" size="sm">
								{createError}
							</Text>
						)}
						<div>
							<span className="text-sm font-medium text-kumo-default mb-1.5 block">
								邮箱地址
							</span>
							<div className="flex items-center gap-2">
								<div className="flex-1">
									<Input
									aria-label="邮箱地址前缀"
										placeholder="info"
										size="sm"
										value={newPrefix}
										onChange={(e) => setNewPrefix(e.target.value)}
										required
									/>
								</div>
								<span className="text-sm text-kumo-subtle">@</span>
								{domains.length > 1 ? (
									<div className="flex-1">
										<Select
											aria-label="邮箱域名"
											value={selectedDomain}
											onValueChange={(value) => {
												if (value) setSelectedDomain(value);
											}}
										>
											{domains.map((d) => (
												<Select.Option key={d} value={d}>
													{d}
												</Select.Option>
											))}
										</Select>
									</div>
								) : (
									<span className="text-sm text-kumo-subtle">
										{selectedDomain || "未配置域名"}
									</span>
								)}
							</div>
						</div>
						<Input
							label="显示名称（选填）"
							placeholder="例如：申请咨询"
							size="sm"
							value={newName}
							onChange={(e) => setNewName(e.target.value)}
						/>
						<div className="flex justify-end gap-2 pt-2">
							<Dialog.Close
								render={(props) => (
									<Button {...props} variant="secondary" size="sm">
										取消
									</Button>
								)}
							/>
							<Button
								type="submit"
								variant="primary"
								size="sm"
								loading={isCreating}
								disabled={!selectedDomain}
							>
								创建
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>

			{/* Delete Dialog */}
			<Dialog.Root
				open={isDeleteOpen}
				onOpenChange={(open) => {
					setIsDeleteOpen(open);
					if (!open) setMailboxToDelete(null);
				}}
			>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-2">
						删除邮箱
					</Dialog.Title>
					<Dialog.Description className="text-kumo-subtle text-sm mb-5">
						确定删除{" "}
						<strong className="text-kumo-default">
							{mailboxToDelete?.email}
						</strong>
						？此操作无法撤销。
					</Dialog.Description>
					<div className="flex justify-end gap-2">
						<Dialog.Close
							render={(props) => (
								<Button {...props} variant="secondary" size="sm">
									取消
								</Button>
							)}
						/>
						<Button
							variant="destructive"
							size="sm"
							loading={isDeleting}
							onClick={handleDelete}
						>
							删除
						</Button>
					</div>
				</Dialog>
			</Dialog.Root>
		</div>
	);
}
