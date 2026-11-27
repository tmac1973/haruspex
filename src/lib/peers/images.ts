/**
 * Another computer's pictures. An image in its messages is a
 * `haruspex-img:` URL that means its own cache, not this one's, so this asks
 * that computer which image a URL is (`peer_images_lookup`, the web page's
 * rule) and reads its bytes (`peer_image`) into a blob URL. Each is fetched
 * once per computer, and released when the computer goes.
 */
import { invoke } from '@tauri-apps/api/core';

import type { ImageRow } from '#lib/ipc/gen/ImageRow.ts';

/** Per computer: blob URLs by image hash, as they arrive. */
const byPeer = new Map<string, Map<string, Promise<string | null>>>();

function blobs(peerId: string): Map<string, Promise<string | null>> {
	let map = byPeer.get(peerId);
	if (!map) byPeer.set(peerId, (map = new Map()));
	return map;
}

/**
 * A blob URL for `url` as that computer has it cached, or null when it has
 * no such image (or can't be reached; asking again later may work).
 */
export async function peerImageUrl(peerId: string, url: string): Promise<string | null> {
	let row: ImageRow | undefined;
	try {
		const found = await invoke<{ images: Record<string, ImageRow> }>('peer_images_lookup', {
			peerId,
			urls: [url]
		});
		row = found?.images?.[url];
	} catch {
		return null;
	}
	if (!row) return null;
	return peerImageByHash(peerId, row.hash, row.mime);
}

/**
 * A blob URL for the image that computer caches as `hash` (a Code step's
 * picture names it so), or null when it has none.
 */
export function peerImageByHash(peerId: string, hash: string, mime = ''): Promise<string | null> {
	const map = blobs(peerId);
	let made = map.get(hash);
	if (!made) {
		made = invoke<ArrayBuffer>('peer_image', { peerId, hash }).then(
			(bytes) => URL.createObjectURL(new Blob([bytes], mime ? { type: mime } : {})),
			() => {
				// Not cached: the next ask tries again.
				map.delete(hash);
				return null;
			}
		);
		map.set(hash, made);
	}
	return made;
}

/** Let go of a computer's pictures. */
export function releasePeerImages(peerId: string): void {
	const map = byPeer.get(peerId);
	byPeer.delete(peerId);
	for (const made of map?.values() ?? []) {
		void made.then((blobUrl) => {
			if (blobUrl) URL.revokeObjectURL(blobUrl);
		});
	}
}
