/**
 * Files for an outgoing message, staged in Rust (`integrations/email/
 * parts.rs`) before the review dialog opens: pictures the HTML shows and
 * attachments. `email_send` names them by id; whatever a draft staged and
 * did not send is dropped when the dialog closes.
 */
import { invoke } from '@tauri-apps/api/core';

/** The most a message's files may add up to, as Rust counts it. */
export const MAX_MESSAGE_BYTES = 18 * 1024 * 1024;

/** A staged file a draft may send. */
export interface StagedFile {
	/** The id `email_part_stage` returned. */
	partId: string;
	name: string;
	mime: string;
	size: number;
}

/** A staged picture the Markdown shows as `![…](cid:<cid>)`. */
export interface StagedPicture extends StagedFile {
	cid: string;
	/** Where the dialog's preview shows it from (a data or app URL). */
	previewUrl: string;
}

/** Stage one file; resolves to its id. */
export function stagePart(name: string, mime: string, bytes: Uint8Array): Promise<string> {
	return invoke<string>('email_part_stage', bytes, {
		headers: { 'x-name': encodeURIComponent(name), 'x-mime': encodeURIComponent(mime) }
	});
}

/** Forget staged files. Never fails: a file already gone is fine. */
export async function dropParts(ids: string[]): Promise<void> {
	if (ids.length === 0) return;
	try {
		await invoke('email_part_drop', { ids });
	} catch (e) {
		console.warn('email: staged files were not dropped', e);
	}
}

/** "1.2 MB", "340 KB". */
export function formatSize(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
