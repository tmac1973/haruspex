/**
 * Client-side image helpers for chat attachments (drag-drop / paste). Images
 * are downscaled before they enter the conversation so a 4K screenshot doesn't
 * blow the model's context or slow inference.
 */

/** Longest-edge cap for attached images, in CSS pixels. */
const DEFAULT_MAX_DIM = 1024;

/** Read an image File and return a (downscaled) PNG data URL. PNG keeps text
 *  and UI edges crisp, which matters for troubleshooting screenshots. */
export async function imageFileToDataUrl(file: File, maxDim = DEFAULT_MAX_DIM): Promise<string> {
	const dataUrl = await new Promise<string>((resolve, reject) => {
		const fr = new FileReader();
		fr.onload = () => resolve(fr.result as string);
		fr.onerror = () => reject(fr.error ?? new Error('Failed to read image'));
		fr.readAsDataURL(file);
	});
	return downscaleDataUrl(dataUrl, maxDim);
}

/** Downscale a data URL so its longest edge is <= maxDim. Returns the original
 *  if it's already small enough or anything goes wrong (best-effort). */
export function downscaleDataUrl(dataUrl: string, maxDim = DEFAULT_MAX_DIM): Promise<string> {
	return new Promise((resolve) => {
		const img = new Image();
		img.onload = () => {
			const longest = Math.max(img.width, img.height);
			if (!longest || longest <= maxDim) {
				resolve(dataUrl);
				return;
			}
			const scale = maxDim / longest;
			const canvas = document.createElement('canvas');
			canvas.width = Math.round(img.width * scale);
			canvas.height = Math.round(img.height * scale);
			const ctx = canvas.getContext('2d');
			if (!ctx) {
				resolve(dataUrl);
				return;
			}
			ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
			try {
				resolve(canvas.toDataURL('image/png'));
			} catch {
				resolve(dataUrl);
			}
		};
		img.onerror = () => resolve(dataUrl);
		img.src = dataUrl;
	});
}

/** Extract image files from a drop or paste payload. Drops expose them on
 *  `.files`; clipboard pastes often only via `.items` (kind 'file'). */
export function imageFilesFrom(dt: DataTransfer | null | undefined): File[] {
	if (!dt) return [];
	const files: File[] = [];
	if (dt.files?.length) {
		for (const f of Array.from(dt.files)) if (f.type.startsWith('image/')) files.push(f);
	}
	if (!files.length && dt.items?.length) {
		for (const it of Array.from(dt.items)) {
			if (it.kind === 'file' && it.type.startsWith('image/')) {
				const f = it.getAsFile();
				if (f) files.push(f);
			}
		}
	}
	return files;
}
