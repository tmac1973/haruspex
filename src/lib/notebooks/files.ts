/**
 * Getting files into a notebook: picked in a dialog or dropped, kept in the
 * notebook file store, and added as an image card (pictures) or an
 * attachment card (anything else).
 */
import { open, save } from '@tauri-apps/plugin-dialog';
import * as api from '#lib/notebooks/api.ts';
import type { NotebookCard, NotebookFile, NotebookSource } from '#lib/notebooks/api.ts';
import { addCard } from '#lib/stores/notebooks.svelte.ts';
import { showToast } from '#lib/stores/toasts.svelte.ts';
import { errMessage } from '#lib/utils/error.ts';

/** A file card's `meta`. */
export type FileMeta = NotebookFile;

export function fileMeta(card: NotebookCard): FileMeta | null {
	const m = api.parseMeta<Partial<FileMeta>>(card.meta);
	return typeof m.hash === 'string' && typeof m.name === 'string'
		? { hash: m.hash, name: m.name, mime: m.mime ?? 'application/octet-stream', size: m.size ?? 0 }
		: null;
}

/** Which card a stored file becomes. */
export function kindFor(file: NotebookFile): 'image' | 'attachment' {
	return /^image\/(png|jpe?g|gif|webp|bmp|avif|svg\+xml)$/.test(file.mime) ? 'image' : 'attachment';
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Keep each file at `paths` and add it as a card, in order, after `after`. */
export async function addFilesAsCards(
	paths: string[],
	after: string | null,
	source: NotebookSource = api.USER_SOURCE,
	only?: 'image' | 'attachment'
): Promise<void> {
	let prev = after;
	for (const path of paths) {
		try {
			const file = await api.storeFilePath(path);
			const added = await addCard(
				{
					kind: only ?? kindFor(file),
					title: file.name.replace(/\.[^.]+$/, ''),
					body: '',
					meta: JSON.stringify(file),
					rows: null
				},
				prev,
				source
			);
			if (added) prev = added.id;
		} catch (e) {
			showToast(errMessage(e), { kind: 'error' });
		}
	}
}

/** "+ Add card → Picture… / File…": pick files and add them. */
export async function pickFilesAsCards(kind: 'image' | 'attachment', after: string | null) {
	const picked = await open({
		multiple: true,
		filters:
			kind === 'image'
				? [
						{
							name: 'Pictures',
							extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg']
						}
					]
				: undefined
	});
	if (!picked) return;
	const paths = Array.isArray(picked) ? picked : [picked];
	await addFilesAsCards(paths, after, api.USER_SOURCE, kind);
}

/** "Save a copy…" for a kept file. */
export async function saveFileCopy(file: FileMeta): Promise<void> {
	const path = await save({ defaultPath: file.name });
	if (!path) return;
	try {
		await api.saveFileAs(file.hash, path);
		showToast('Saved.', { kind: 'success' });
	} catch (e) {
		showToast(errMessage(e), { kind: 'error' });
	}
}

/** "Open" a kept file in the app the system uses for it. */
export async function openFileCard(file: FileMeta): Promise<void> {
	try {
		await api.openFile(file.hash, file.name);
	} catch (e) {
		showToast(errMessage(e), { kind: 'error' });
	}
}
