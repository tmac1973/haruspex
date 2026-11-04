/**
 * Code → Open: any file, in its folder's editor window (a model, image or
 * sound in its viewer, anything else as text), or a folder, which opens on
 * its first model, image or sound with the rest listed beside it.
 */

import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { openInEditorWindows } from '#lib/editor/windows.ts';
import type { ViewableListing } from '#lib/ipc/gen/ViewableListing.ts';
import { firstFile } from '#lib/editor/viewerList.ts';
import { showToast } from '#lib/stores/toasts.svelte.ts';
import { errMessage } from '#lib/utils/error.ts';

/** `/a/b/c.glb` → `['/a/b', 'c.glb']`; either separator, for Windows. */
export function splitFilePath(path: string): [string, string] {
	const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	if (cut < 0) return ['.', path];
	return [cut === 0 ? path.slice(0, 1) : path.slice(0, cut), path.slice(cut + 1)];
}

export async function openFile(): Promise<void> {
	const path = await open({ title: 'Open file' });
	if (typeof path !== 'string') return;
	const [root, file] = splitFilePath(path);
	await show(root, file);
}

export async function openFolder(): Promise<void> {
	const root = await open({ title: 'Open a folder', directory: true });
	if (typeof root !== 'string') return;
	try {
		const { files } = await invoke<ViewableListing>('editor_list_viewable', { workdir: root });
		const first = firstFile(files);
		if (!first) {
			showToast(`No models, images or sounds in ${root}.`, { kind: 'error' });
			return;
		}
		await show(root, first);
	} catch (e) {
		showToast(`Couldn't list the folder: ${errMessage(e)}`, { kind: 'error' });
	}
}

async function show(root: string, file: string): Promise<void> {
	try {
		await openInEditorWindows(root, [file]);
	} catch (e) {
		showToast(`The editor window could not open: ${errMessage(e)}`, { kind: 'error' });
	}
}
