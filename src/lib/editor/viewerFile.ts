/**
 * What the read-only viewers (image, sound, 3D model) share: the file's
 * bytes read fresh, a Blob URL to hand an element, and the one-line error
 * shown in place of the file.
 */
import { invoke } from '@tauri-apps/api/core';
import { errMessage } from '#lib/utils/error.ts';

/** A workspace file's bytes, read fresh. */
export async function readViewerBytes(
	workdir: string,
	relPath: string
): Promise<Uint8Array<ArrayBuffer>> {
	return new Uint8Array(await invoke<number[]>('fs_read_bytes', { workdir, relPath }));
}

/** The bytes as a Blob URL of `type` ('' when unknown). The caller revokes it. */
export function blobUrlOf(data: Uint8Array<ArrayBuffer>, type: string): string {
	return URL.createObjectURL(new Blob([data], { type }));
}

/** Why a viewer shows nothing: "Could not show art/x.png: …". */
export function viewerError(verb: 'show' | 'play', relPath: string, e: unknown): string {
	return `Could not ${verb} ${relPath}: ${errMessage(e)}`;
}
