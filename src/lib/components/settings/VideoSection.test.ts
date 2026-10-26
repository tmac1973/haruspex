import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { invoke } from '@tauri-apps/api/core';
import { invokeRouter } from '#lib/testing/invoke.ts';
import type { VideoBinariesStatus } from '#lib/ipc/gen/VideoBinariesStatus.ts';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

const settings = vi.hoisted(() => ({
	videoFfmpegPath: '',
	videoFfprobePath: '',
	videoMeltPath: '',
	videoPreset: '1080p60',
	videoIntroPath: '',
	videoOutroPath: '',
	videoEncoder: 'libx264'
}));
vi.mock('#lib/stores/settings.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/stores/settings.ts')>()),
	getSettings: () => settings,
	updateSettings: vi.fn((patch: object) => Object.assign(settings, patch))
}));

import VideoSection from './VideoSection.svelte';
import { updateSettings } from '#lib/stores/settings.ts';

const found = (name: string, source: 'path' | 'kdenlive' | 'override' = 'path') => ({
	path: `/usr/bin/${name}`,
	version: `${name} 7.1`,
	source
});

let status: VideoBinariesStatus;

beforeEach(() => {
	Object.assign(settings, {
		videoFfmpegPath: '',
		videoFfprobePath: '',
		videoMeltPath: '',
		videoPreset: '1080p60',
		videoIntroPath: '',
		videoOutroPath: '',
		videoEncoder: 'libx264'
	});
	status = {
		ffmpeg: found('ffmpeg'),
		ffprobe: found('ffprobe'),
		melt: found('melt', 'kdenlive'),
		hints: []
	};
	vi.mocked(invoke).mockImplementation(
		invokeRouter({
			video_binaries_status: () => status,
			video_encoders_test: () => [
				{ id: 'libx264', label: 'x264 (software)' },
				{ id: 'h264_vaapi', label: 'VA-API (AMD, Intel)' }
			]
		})
	);
	vi.mocked(updateSettings).mockClear();
});

describe('VideoSection', () => {
	it('shows what it found and where', async () => {
		render(VideoSection);
		expect(await screen.findByText('melt 7.1 (Kdenlive)')).toBeTruthy();
		expect(screen.getByText('ffmpeg 7.1 (PATH)')).toBeTruthy();
		expect(screen.getByText(/Video tools are on/)).toBeTruthy();
	});

	it('says what to install when one is missing', async () => {
		status = { ...status, melt: null, hints: ['Not found: melt.'] };
		render(VideoSection);
		expect(await screen.findByText('Not found')).toBeTruthy();
		expect(screen.getByText('Install Kdenlive, or set the paths above.')).toBeTruthy();
	});

	it('saves an override path as a plain string and looks again', async () => {
		render(VideoSection);
		await screen.findByText('melt 7.1 (Kdenlive)');
		const input = screen.getByLabelText('melt:') as HTMLInputElement;
		await fireEvent.input(input, { target: { value: ' /opt/melt ' } });
		await fireEvent.blur(input);
		expect(updateSettings).toHaveBeenCalledWith({ videoMeltPath: '/opt/melt' });
		expect(typeof settings.videoMeltPath).toBe('string');
		expect(
			vi.mocked(invoke).mock.calls.filter(([c]) => c === 'video_binaries_status')
		).toHaveLength(2);
	});

	it('offers the encoders that passed their test and saves the choice', async () => {
		render(VideoSection);
		expect(await screen.findByText('VA-API (AMD, Intel)')).toBeTruthy();
		const select = screen.getByLabelText('Encoder:') as HTMLSelectElement;
		await fireEvent.change(select, { target: { value: 'h264_vaapi' } });
		expect(updateSettings).toHaveBeenCalledWith({ videoEncoder: 'h264_vaapi' });
	});

	it('saves the format', async () => {
		render(VideoSection);
		const select = screen.getByLabelText('Format:') as HTMLSelectElement;
		await fireEvent.change(select, { target: { value: '1440p60' } });
		expect(updateSettings).toHaveBeenCalledWith({ videoPreset: '1440p60' });
	});
});
