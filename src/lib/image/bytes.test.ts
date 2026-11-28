import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

import { invoke } from '@tauri-apps/api/core';
import { invokeRouter } from '#lib/testing/invoke.ts';
import { imageDataUrl, isFullyOpaque, mimeOf, readCachedImage } from './bytes.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

beforeEach(() => {
	vi.mocked(invoke).mockReset();
});

describe('mimeOf', () => {
	it('knows PNG, JPEG, WebP and GIF by their first bytes', () => {
		expect(mimeOf(PNG)).toBe('image/png');
		expect(mimeOf(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
		expect(
			mimeOf(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))
		).toBe('image/webp');
		expect(mimeOf(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBe('image/gif');
		expect(mimeOf(new Uint8Array([1, 2, 3]))).toBe('image/png');
	});
});

describe('readCachedImage', () => {
	it('reads the bytes by hash', async () => {
		vi.mocked(invoke).mockImplementation(invokeRouter({ image_read_bytes: () => PNG.buffer }));
		expect(await readCachedImage('abc')).toEqual(PNG);
		expect(invoke).toHaveBeenCalledWith('image_read_bytes', { hash: 'abc' });
	});

	it('rejects when the picture is gone', async () => {
		vi.mocked(invoke).mockRejectedValue(new Error('not found'));
		await expect(readCachedImage('abc')).rejects.toThrow('not found');
	});
});

describe('imageDataUrl', () => {
	it('names the type and encodes the bytes', () => {
		expect(imageDataUrl(PNG)).toBe('data:image/png;base64,iVBORw==');
	});
});

describe('isFullyOpaque', () => {
	it('is true when no pixel is clear', async () => {
		vi.mocked(invoke).mockImplementation(invokeRouter({ image_transparent_fraction: 0 }));
		expect(await isFullyOpaque(PNG)).toBe(true);
	});

	it('is false when some pixels are clear', async () => {
		vi.mocked(invoke).mockImplementation(invokeRouter({ image_transparent_fraction: 0.4 }));
		expect(await isFullyOpaque(PNG)).toBe(false);
	});

	it('is false when the check fails', async () => {
		vi.mocked(invoke).mockRejectedValue(new Error('decode failed'));
		expect(await isFullyOpaque(PNG)).toBe(false);
	});
});
