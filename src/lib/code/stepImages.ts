/**
 * A Code step's picture (a `check_3d` sheet, a screenshot) kept in the image
 * cache and named by hash, not carried in the thread as a `data:` URL. A
 * sheet is ~70 KB of base64, and every save writes the whole thread: a long
 * 3D session's threads held hundreds of MB of them, in memory and copied on
 * each save, until the web process died (#996). The cache links each one to
 * its session (`code_session_images`), so it lives as long as the session.
 */
import { invoke } from '@tauri-apps/api/core';

import type { SearchStep } from '#lib/agent/loop.ts';
import { imageSrc } from '#lib/images/url.ts';
import { dataUrlBytes } from '#lib/utils/base64.ts';

/** A PNG's width and height from its IHDR chunk, or zeros for any other format. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } {
	const png = [0x89, 0x50, 0x4e, 0x47];
	if (bytes.length < 24 || png.some((b, i) => bytes[i] !== b)) return { width: 0, height: 0 };
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Store a step's `data:` picture for session `sessionId`; its hash, or null when it can't be. */
export async function storeStepImage(dataUrl: string, sessionId: string): Promise<string | null> {
	const bytes = dataUrlBytes(dataUrl);
	if (!bytes) return null;
	const mime = dataUrl.slice(5, dataUrl.indexOf(';')) || 'image/png';
	try {
		return await invoke<string>('image_store_bytes', {
			bytes: Array.from(bytes),
			mime,
			...imageSize(bytes),
			conversationId: null,
			codeSessionId: sessionId
		});
	} catch (e) {
		console.warn('A step picture stays in the thread; the image cache refused it:', e);
		return null;
	}
}

/**
 * `steps` with the picture `dataUrl` named by `hash` instead, or null when no
 * step shows it.
 */
export function withStoredImage(
	steps: SearchStep[],
	dataUrl: string,
	hash: string
): SearchStep[] | null {
	if (!steps.some((s) => s.thumbDataUrl === dataUrl)) return null;
	return steps.map((s) => {
		if (s.thumbDataUrl !== dataUrl) return s;
		const next: SearchStep = { ...s, thumbHash: hash };
		delete next.thumbDataUrl;
		return next;
	});
}

/** What an `<img>` shows for a step's picture, or null when it has none. */
export function stepImageSrc(step: Pick<SearchStep, 'thumbDataUrl' | 'thumbHash'>): string | null {
	if (step.thumbDataUrl) return step.thumbDataUrl;
	return step.thumbHash ? imageSrc(step.thumbHash) : null;
}
