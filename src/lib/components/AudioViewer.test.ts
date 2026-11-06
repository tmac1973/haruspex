import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore({}, [1, 2, 3])
);

import AudioViewer from './AudioViewer.svelte';

URL.createObjectURL = vi.fn(() => 'blob:sound');
URL.revokeObjectURL = vi.fn();
globalThis.ResizeObserver ??= class {
	observe() {}
	disconnect() {}
} as unknown as typeof ResizeObserver;

describe('AudioViewer', () => {
	it('plays the file in the app player, with its size', async () => {
		const { container } = render(AudioViewer, { workdir: '/proj', relPath: 'sfx/hit.wav' });
		await screen.findByText('hit.wav');
		expect(container.querySelector('audio')?.getAttribute('src')).toBe('blob:sound');
		screen.getByText('3 B');
	});

	it('loops when asked, and says so when the system cannot play it', async () => {
		const { container } = render(AudioViewer, { workdir: '/proj', relPath: 'song.m4a' });
		await screen.findByText('song.m4a');
		await fireEvent.click(screen.getByLabelText('Loop'));
		const audio = container.querySelector('audio')!;
		expect(audio.loop).toBe(true);
		await fireEvent.error(audio);
		screen.getByText(/no decoder for it/);
	});
});
