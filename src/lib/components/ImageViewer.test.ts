import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore({}, [1, 2, 3])
);

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
		screen.getByText(/640 × 480 px/);

		await fireEvent.click(screen.getByText('1:1'));
		screen.getByText('Fit');
	});

	it('drags the image around at 1:1, but not when fitted', async () => {
		render(ImageViewer, { workdir: '/proj', relPath: 'sheet.png' });
		await screen.findByAltText('sheet.png');
		const stage = screen.getByTestId('image-viewer').querySelector('.stage') as HTMLElement;
		// jsdom lays nothing out: give the stage a 200 × 200 inside.
		Object.defineProperty(stage, 'clientWidth', { value: 200 });
		Object.defineProperty(stage, 'clientHeight', { value: 200 });
		const drag = async () => {
			await fireEvent.pointerDown(stage, { button: 0, clientX: 100, clientY: 100 });
			await fireEvent.pointerMove(stage, { clientX: 60, clientY: 70 });
			await fireEvent.pointerUp(stage);
		};
		await drag();
		expect([stage.scrollLeft, stage.scrollTop]).toEqual([0, 0]);

		await fireEvent.click(screen.getByText('1:1'));
		await drag();
		expect([stage.scrollLeft, stage.scrollTop]).toEqual([40, 30]);
		await fireEvent.pointerMove(stage, { clientX: 0, clientY: 0 });
		expect([stage.scrollLeft, stage.scrollTop]).toEqual([40, 30]);

		// On the scroll bar, past the inside.
		await fireEvent.pointerDown(stage, { button: 0, clientX: 205, clientY: 100 });
		await fireEvent.pointerMove(stage, { clientX: 150, clientY: 100 });
		expect([stage.scrollLeft, stage.scrollTop]).toEqual([40, 30]);
	});

	it('says so when the file is not an image it can read', async () => {
		render(ImageViewer, { workdir: '/proj', relPath: 'broken.png' });
		await fireEvent.error(await screen.findByAltText('broken.png'));
		screen.getByText(/Could not show broken.png/);
	});
});
