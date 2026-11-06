import { invoke } from '@tauri-apps/api/core';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

import { blobUrlOf, readViewerBytes, viewerError } from './viewerFile';

describe('readViewerBytes', () => {
	it('reads the file fresh, as bytes', async () => {
		vi.mocked(invoke).mockResolvedValueOnce([1, 2, 3]);
		const data = await readViewerBytes('/w', 'a/b.png');
		expect(invoke).toHaveBeenCalledWith('fs_read_bytes', {
			workdir: '/w',
			relPath: 'a/b.png'
		});
		expect(data).toEqual(new Uint8Array([1, 2, 3]));
	});
});

describe('blobUrlOf', () => {
	it('makes a Blob of the type given', () => {
		const create = vi.fn((b: Blob) => (b.type ? `blob:${b.type}` : 'blob:'));
		const original = URL.createObjectURL;
		URL.createObjectURL = create as typeof URL.createObjectURL;
		try {
			expect(blobUrlOf(new Uint8Array([1]), 'image/png')).toBe('blob:image/png');
			expect(create.mock.calls[0][0].size).toBe(1);
		} finally {
			URL.createObjectURL = original;
		}
	});
});

describe('viewerError', () => {
	it('names the file and the reason', () => {
		expect(viewerError('show', 'x.glb', new Error('bad header'))).toBe(
			'Could not show x.glb: bad header'
		);
		expect(viewerError('play', 'y.wav', 'gone')).toBe('Could not play y.wav: gone');
	});
});
