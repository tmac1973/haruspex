import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { invoke } from '@tauri-apps/api/core';
import { invokeRouter } from '#lib/testing/invoke.ts';
import type { VideoBinariesStatus } from '#lib/ipc/gen/VideoBinariesStatus.ts';
import type { BinarySource } from '#lib/ipc/gen/BinarySource.ts';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

const settings = vi.hoisted(() => ({
	videoEditingEnabled: false,
	videoFfmpegChoice: 'auto',
	videoMeltChoice: 'auto',
	videoFfmpegPath: '',
	videoFfprobePath: '',
	videoMeltPath: '',
	videoPreset: '1080p60',
	videoIntroPath: '',
	videoOutroPath: '',
	videoEncoder: 'libx264'
}));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: () => settings,
		updateSettings: vi.fn((patch: object) => Object.assign(settings, patch))
	})
);

import VideoEditingSection from './VideoEditingSection.svelte';
import { updateSettings } from '#lib/stores/settings.ts';

const found = (name: string, source: BinarySource = 'path') => ({
	path: `/usr/bin/${name}`,
	version: `${name} 7.1`,
	source
});

let status: VideoBinariesStatus;

beforeEach(() => {
	Object.assign(settings, {
		videoEditingEnabled: false,
		videoFfmpegChoice: 'auto',
		videoMeltChoice: 'auto',
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
		melt: found('melt', 'editor'),
		hints: []
	};
	vi.mocked(invoke).mockImplementation(
		invokeRouter({
			video_binaries_status: () => status,
			whisper_video_model_path: () => null,
			whisper_video_model_download: () => '/models/whisper/ggml-large-v3-turbo.bin',
			video_encoders_test: () => [
				{ id: 'libx264', label: 'x264 (software)' },
				{ id: 'h264_vaapi', label: 'VA-API (AMD, Intel)' }
			]
		})
	);
	vi.mocked(updateSettings).mockClear();
});

describe('VideoEditingSection', () => {
	it('shows what it found and where', async () => {
		render(VideoEditingSection);
		await screen.findByText('melt 7.1 (Shotcut or Kdenlive)');
		screen.getByText('ffmpeg 7.1 (PATH)');
	});

	it('says when ffmpeg is the copy that ships with Haruspex', async () => {
		status = {
			...status,
			ffmpeg: {
				...found('ffmpeg', 'bundled'),
				version: 'ffmpeg version n8.1.3 Copyright (c) 2000-2026 the FFmpeg developers'
			}
		};
		render(VideoEditingSection);
		await screen.findByText('ffmpeg n8.1.3 (bundled)');
	});

	it('turns the video tools on with its switch', async () => {
		render(VideoEditingSection);
		const box = screen.getByLabelText(/edit videos/) as HTMLInputElement;
		expect(box.checked).toBe(false);
		await fireEvent.click(box);
		expect(updateSettings).toHaveBeenCalledWith({ videoEditingEnabled: true });
	});

	it('says what to install when one is missing', async () => {
		status = { ...status, melt: null, hints: ['Not found: melt.'] };
		render(VideoEditingSection);
		await screen.findByText('Not found');
		screen.getByText('Choose Automatic, or set the paths above.');
	});

	it('saves an override path as a plain string and looks again', async () => {
		render(VideoEditingSection);
		await screen.findByText('melt 7.1 (Shotcut or Kdenlive)');
		expect(screen.queryByLabelText('melt path:')).toBeNull();
		await fireEvent.change(screen.getByLabelText('melt:'), { target: { value: 'custom' } });
		expect(updateSettings).toHaveBeenCalledWith({ videoMeltChoice: 'custom' });
		const input = screen.getByLabelText('melt path:') as HTMLInputElement;
		await fireEvent.input(input, { target: { value: ' /opt/melt ' } });
		await fireEvent.blur(input);
		expect(updateSettings).toHaveBeenCalledWith({ videoMeltPath: '/opt/melt' });
		expect(typeof settings.videoMeltPath).toBe('string');
		expect(
			vi.mocked(invoke).mock.calls.filter(([c]) => c === 'video_binaries_status')
		).toHaveLength(3);
	});

	it('picks which ffmpeg to use, with paths only for a custom one', async () => {
		render(VideoEditingSection);
		await screen.findByText('melt 7.1 (Shotcut or Kdenlive)');
		expect(screen.queryByLabelText('ffmpeg path:')).toBeNull();
		const use = screen.getByLabelText('ffmpeg and ffprobe:') as HTMLSelectElement;
		await fireEvent.change(use, { target: { value: 'custom' } });
		expect(updateSettings).toHaveBeenCalledWith({ videoFfmpegChoice: 'custom' });
		screen.getByLabelText('ffmpeg path:');
		screen.getByLabelText('ffprobe path:');
		// melt keeps its own choice.
		expect(screen.queryByLabelText('melt path:')).toBeNull();
		await fireEvent.change(use, { target: { value: 'bundled' } });
		expect(updateSettings).toHaveBeenCalledWith({ videoFfmpegChoice: 'bundled' });
		expect(screen.queryByLabelText('ffmpeg path:')).toBeNull();
		settings.videoFfmpegChoice = 'auto';
	});

	it('offers the encoders that passed their test and saves the choice', async () => {
		render(VideoEditingSection);
		await screen.findByText('VA-API (AMD, Intel)');
		const select = screen.getByLabelText('Encoder:') as HTMLSelectElement;
		await fireEvent.change(select, { target: { value: 'h264_vaapi' } });
		expect(updateSettings).toHaveBeenCalledWith({ videoEncoder: 'h264_vaapi' });
	});

	it('downloads the transcription model', async () => {
		render(VideoEditingSection);
		const button = await screen.findByText('Download large-v3-turbo (1.6 GB)');
		await fireEvent.click(button);
		await screen.findByText('whisper large-v3-turbo');
	});

	it('saves the format', async () => {
		render(VideoEditingSection);
		const select = screen.getByLabelText('Format:') as HTMLSelectElement;
		await fireEvent.change(select, { target: { value: '1440p60' } });
		expect(updateSettings).toHaveBeenCalledWith({ videoPreset: '1440p60' });
	});
});
