/**
 * Reads the binary body `sandbox_sync_workdir` answers with (see
 * `encode_sync` in sandbox_sync.rs): a little-endian u32 header length, the
 * header as JSON, then every file's bytes end to end. Each file's `bytes` is
 * a view into `body`, so transferring `body` to the worker copies nothing.
 */
import type { SyncFile, SyncSkipped } from '#lib/sandbox/protocol.ts';

interface SyncHeader {
	to_sync: Array<{ path: string; abs_path: string; mtime: number; len: number }>;
	deleted: string[];
	skipped: SyncSkipped[];
	workdir_abs: string;
}

export interface SyncBody {
	to_sync: SyncFile[];
	deleted: string[];
	skipped: SyncSkipped[];
	workdir_abs: string;
}

export function decodeSyncBody(body: ArrayBuffer): SyncBody {
	const headerLen = new DataView(body).getUint32(0, true);
	const header = JSON.parse(
		new TextDecoder().decode(new Uint8Array(body, 4, headerLen))
	) as SyncHeader;
	let offset = 4 + headerLen;
	const to_sync = header.to_sync.map((f) => {
		const bytes = new Uint8Array(body, offset, f.len);
		offset += f.len;
		return { path: f.path, abs_path: f.abs_path, bytes, mtime: f.mtime };
	});
	return {
		to_sync,
		deleted: header.deleted,
		skipped: header.skipped,
		workdir_abs: header.workdir_abs
	};
}
