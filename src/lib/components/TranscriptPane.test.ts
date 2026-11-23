import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore({ voices_list: [] })
);
vi.mock('@tauri-apps/api/event', () => ({ emitTo: vi.fn(), listen: vi.fn() }));

import TranscriptPane from './TranscriptPane.svelte';
import type { TranscriptIO } from '#lib/video/transcriptModel.svelte.ts';
import type { SpeechEdits } from '#lib/video/edits.ts';

const words = ['So', 'um', 'we', 'start'].map((text, i) => ({ start: i, end: i + 0.8, text }));
const found = {
	transcript: {
		path: 'raw/obs.mp4',
		model: 'm',
		language: 'en',
		durationSecs: 4,
		segments: [{ start: 0, end: 4, text: 'So um we start', words }]
	},
	episode: '',
	cachePath: '/v/.haruspex/transcripts/obs-1.v3.json',
	editsPath: '.haruspex/edits/obs.edits.json'
};

function fakeIO(): TranscriptIO & { written: string[] } {
	const written: string[] = [];
	return {
		written,
		find: async () => found,
		transcribe: async () => {},
		readText: async () => null,
		writeText: async (_w, _p, text) => {
			written.push(text);
		}
	};
}

describe('TranscriptPane', () => {
	it('seeks to a word when it is clicked, and marks the word playing', async () => {
		const onseek = vi.fn();
		render(TranscriptPane, {
			workdir: '/v',
			relPath: 'raw/obs.mp4',
			time: 2.2,
			onseek,
			io: fakeIO()
		});
		await fireEvent.click(await screen.findByRole('button', { name: 'um' }));
		expect(onseek).toHaveBeenCalledWith(1);
		expect(screen.getByRole('button', { name: 'we' }).classList).toContain('current');
	});

	it('cuts two selected words as one edit, and saves it', async () => {
		const io = fakeIO();
		render(TranscriptPane, { workdir: '/v', relPath: 'raw/obs.mp4', time: 0, onseek: vi.fn(), io });
		await fireEvent.click(await screen.findByRole('button', { name: 'um' }));
		await fireEvent.click(screen.getByRole('button', { name: 'we' }), { shiftKey: true });
		await fireEvent.click(screen.getByRole('button', { name: 'Cut' }));
		screen.getByText('Cut “um we”');
		expect(screen.getByRole('button', { name: 'um' }).classList).toContain('cut');
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		const saved = JSON.parse(io.written[0]) as SpeechEdits;
		expect(saved.clip).toBe('raw/obs.mp4');
		expect(saved.edits).toHaveLength(1);
		expect(saved.edits[0]).toMatchObject({ kind: 'cut', from: 1, to: 2.8, words: 'um we' });
	});

	it('offers to transcribe a clip that has no transcript', async () => {
		const io = { ...fakeIO(), find: async () => null };
		render(TranscriptPane, { workdir: '/v', relPath: 'raw/obs.mp4', time: 0, onseek: vi.fn(), io });
		await screen.findByRole('button', { name: 'Transcribe' });
	});
});
