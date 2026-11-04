import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => [1, 2, 3]) }));

import ImageViewer from './ImageViewer.svelte';

URL.createObjectURL = vi.fn(() => 'blob:image');
URL.revokeObjectURL = vi.fn();

describe('ImageViewer', () => {
	it('shows the image and switches between fitted and real size', async () => {
		render(ImageViewer, { workdir: '/proj', relPath: 'sheet.png' });
		const img = (await screen.findByAltText('sheet.png')) as HTMLImageElement;
		expect(img.src).toBe('blob:image');
		Object.defineProperty(img, 'naturalWidth', { value: 640 });
		Object.defineProperty(img, 'naturalHeight', { value: 480 });
		await fireEvent.load(img);
		expect(screen.getByText(/640 × 480 px/)).toBeTruthy();

		await fireEvent.click(screen.getByText('1:1'));
		expect(screen.getByText('Fit')).toBeTruthy();
	});

	it('says so when the file is not an image it can read', async () => {
		render(ImageViewer, { workdir: '/proj', relPath: 'broken.png' });
		await fireEvent.error(await screen.findByAltText('broken.png'));
		expect(screen.getByText(/Could not show broken.png/)).toBeTruthy();
	});
});
