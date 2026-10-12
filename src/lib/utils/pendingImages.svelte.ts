import { imageFileToDataUrl, imageFilesFrom } from '#lib/utils/image.ts';
import { showToast } from '#lib/stores/toasts.svelte.ts';
import { errMessage } from '#lib/utils/error.ts';

export interface PendingImage {
	id: number;
	url: string;
}

/**
 * Images attached to a composer for its next message: pasted, dropped, or
 * handed back by a turn that never used them. Shared by the chat view, the
 * Shell tab's chat sidebar and the Code composer.
 *
 *   const images = createPendingImages();
 *   <textarea onpaste={images.onPaste}>
 *   {#each images.items as img (img.id)} … images.remove(img.id)
 */
export function createPendingImages() {
	let items = $state<PendingImage[]>([]);
	let seq = 0;
	const wrap = (urls: string[]) => urls.map((url) => ({ id: seq++, url }));

	async function addFiles(files: File[]): Promise<void> {
		for (const f of files) {
			try {
				items = [...items, ...wrap([await imageFileToDataUrl(f)])];
			} catch (e) {
				console.error('image attach failed', e);
				showToast(`Couldn't attach image: ${errMessage(e)}`, { kind: 'error' });
			}
		}
	}

	return {
		get items(): PendingImage[] {
			return items;
		},
		get urls(): string[] {
			return items.map((i) => i.url);
		},
		get length(): number {
			return items.length;
		},
		/** Already-encoded data URLs (a native file drop, a screen capture). */
		addUrls(urls: string[]): void {
			items = [...items, ...wrap(urls)];
		},
		/** Put images back ahead of any attached since. */
		prepend(urls: string[]): void {
			items = [...wrap(urls), ...items];
		},
		/** Replace what's attached. */
		set(urls: string[]): void {
			items = wrap(urls);
		},
		remove(id: number): void {
			items = items.filter((i) => i.id !== id);
		},
		clear(): void {
			items = [];
		},
		addFiles,
		/** A composer's `onpaste`: attaches pasted image files, leaves text alone. */
		onPaste(e: ClipboardEvent): void {
			const files = imageFilesFrom(e.clipboardData);
			if (files.length) {
				e.preventDefault();
				void addFiles(files);
			}
		}
	};
}

export type PendingImages = ReturnType<typeof createPendingImages>;
