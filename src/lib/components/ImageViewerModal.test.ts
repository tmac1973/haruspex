import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: tauri.save }));

import ImageViewerModal from './ImageViewerModal.svelte';

const HASH = 'b'.repeat(64);

beforeEach(() => {
	tauri.save.mockReset();
	tauri.invoke
		.mockReset()
		.mockImplementation(async (cmd: string) =>
			cmd === 'image_read_bytes' ? new Uint8Array([0xff, 0xd8, 0xff]).buffer : null
		);
});

describe('ImageViewerModal', () => {
	it('saves a cached picture where the user picks, named by its type', async () => {
		const onClose = vi.fn();
		render(ImageViewerModal, {
			src: `haruspex-img://localhost/${HASH}`,
			alt: 'A lighthouse at dusk',
			onClose
		});
		tauri.save.mockResolvedValueOnce('/home/me/lighthouse.jpg');
		await fireEvent.click(screen.getByRole('button', { name: 'Save as…' }));
		await vi.waitFor(() =>
			expect(tauri.invoke).toHaveBeenCalledWith('image_save_as', {
				hash: HASH,
				path: '/home/me/lighthouse.jpg'
			})
		);
		expect(tauri.save.mock.calls[0][0]).toMatchObject({
			defaultPath: 'a-lighthouse-at-dusk.jpg',
			filters: [{ name: 'Image', extensions: ['jpg'] }]
		});
		expect(await screen.findByText('Saved to /home/me/lighthouse.jpg')).toBeTruthy();
		expect(onClose).not.toHaveBeenCalled();
	});

	it('offers no Save as for a picture that isn’t cached', () => {
		render(ImageViewerModal, { src: 'data:image/png;base64,iVBORw0KGgo=', onClose: () => {} });
		expect(screen.queryByRole('button', { name: 'Save as…' })).toBeNull();
	});
});
