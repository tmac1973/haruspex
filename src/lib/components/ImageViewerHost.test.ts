import { describe, it, expect, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import ImageViewerHost from './ImageViewerHost.svelte';
import { VIEW_IMAGE_EVENT, type ViewImageDetail } from '#lib/markdownActions.ts';
import { closeImageViewer, isImageViewerOpen } from '#lib/stores/imageViewer.svelte.ts';

const url = (h: string) => `haruspex-img://localhost/${h}`;
const stills = [
	{ src: url('a1'), alt: 'opening' },
	{ src: url('b2'), alt: 'forest' },
	{ src: url('c3'), alt: 'ending' }
];

async function view(detail: ViewImageDetail) {
	document.dispatchEvent(new CustomEvent(VIEW_IMAGE_EVENT, { detail }));
	await tick();
}

const shown = () => document.querySelector<HTMLImageElement>('.viewer-img');

afterEach(() => closeImageViewer());

describe('ImageViewerHost', () => {
	it('opens a picture raised from anywhere, and Escape closes it', async () => {
		render(ImageViewerHost);
		await view({ src: url('a1'), alt: 'opening' });
		expect(shown()?.getAttribute('src')).toBe(url('a1'));
		expect(screen.queryByRole('button', { name: 'Next picture' })).toBeNull();
		await fireEvent.keyDown(window, { key: 'Escape' });
		expect(shown()).toBeNull();
		expect(isImageViewerOpen()).toBe(false);
	});

	it('starts at the clicked picture of a set and steps with the arrows, wrapping', async () => {
		render(ImageViewerHost);
		await view({ ...stills[1], gallery: stills });
		expect(screen.getByText('2 of 3 · forest')).toBeTruthy();
		await fireEvent.keyDown(window, { key: 'ArrowRight' });
		expect(shown()?.getAttribute('src')).toBe(url('c3'));
		await fireEvent.keyDown(window, { key: 'ArrowRight' });
		expect(shown()?.getAttribute('src')).toBe(url('a1'));
		await fireEvent.click(screen.getByRole('button', { name: 'Previous picture' }));
		expect(shown()?.getAttribute('src')).toBe(url('c3'));
		expect(screen.getByText('3 of 3 · ending')).toBeTruthy();
	});
});
