import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPendingImages } from './pendingImages.svelte.ts';
import { getToasts } from '#lib/stores/toasts.svelte.ts';

const image = vi.hoisted(() => ({ toDataUrl: vi.fn() }));
vi.mock('#lib/utils/image.ts', () => ({
	imageFileToDataUrl: image.toDataUrl,
	imageFilesFrom: (dt: { files: File[] } | null) => dt?.files ?? []
}));

beforeEach(() => image.toDataUrl.mockReset());

describe('createPendingImages', () => {
	it('adds, prepends, replaces and removes, keeping ids unique', () => {
		const images = createPendingImages();
		images.addUrls(['b', 'c']);
		images.prepend(['a']);
		expect(images.urls).toEqual(['a', 'b', 'c']);
		expect(new Set(images.items.map((i) => i.id)).size).toBe(3);
		images.remove(images.items[1].id);
		expect(images.urls).toEqual(['a', 'c']);
		images.set(['x']);
		expect(images.urls).toEqual(['x']);
		images.clear();
		expect(images.length).toBe(0);
	});

	it('attaches a pasted image and leaves a text paste to the textarea', async () => {
		image.toDataUrl.mockResolvedValue('data:image/png;base64,AA');
		const images = createPendingImages();
		const file = new File(['x'], 'a.png', { type: 'image/png' });
		const pasted = { clipboardData: { files: [file] }, preventDefault: vi.fn() };
		images.onPaste(pasted as unknown as ClipboardEvent);
		await vi.waitFor(() => expect(images.urls).toEqual(['data:image/png;base64,AA']));
		expect(pasted.preventDefault).toHaveBeenCalled();

		const text = { clipboardData: { files: [] }, preventDefault: vi.fn() };
		images.onPaste(text as unknown as ClipboardEvent);
		expect(text.preventDefault).not.toHaveBeenCalled();
	});

	it('says so when an image cannot be read, and keeps the others', async () => {
		image.toDataUrl.mockRejectedValueOnce(new Error('not an image')).mockResolvedValue('ok');
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const images = createPendingImages();
		await images.addFiles([new File([''], 'bad'), new File([''], 'good')]);
		expect(images.urls).toEqual(['ok']);
		expect(getToasts().some((t) => t.message === "Couldn't attach image: not an image")).toBe(true);
		error.mockRestore();
	});
});
