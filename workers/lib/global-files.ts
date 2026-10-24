import type { FileListOptions } from "../../shared/files";
import type { Env } from "../types";
import { FILE_INDEX_NAME } from "./file-index";

/** Both scopes use one index RPC; file reads never enumerate mailboxes. */
export function listGlobalFiles(env: Pick<Env, "FILE_INDEX">, options: FileListOptions, mailboxId?: string) {
	return env.FILE_INDEX.get(env.FILE_INDEX.idFromName(FILE_INDEX_NAME)).listFiles(options, mailboxId);
}
