import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));

import AudioPlayer from './AudioPlayer.svelte';

const SRC = `haruspex-audio://localhost/${'c'.repeat(64)}`;

beforeEach(() => {
	URL.createObjectURL = vi.fn(() => 'blob:song');
	tauri.invoke.mockReset().mockResolvedValue(new Uint8Array([0xff, 0xfb]).buffer);
});

async function loaded() {
	render(AudioPlayer, { src: SRC, title: 'Rain' });
	const audio = document.querySelector('audio')!;
	await vi.waitFor(() => expect(audio.getAttribute('src')).toBe('blob:song'));
	return audio;
}

describe('AudioPlayer', () => {
	it('shows the time and slider from the element’s own events', async () => {
		const audio = await loaded();
		expect(screen.getAllByText('--:--')).toHaveLength(1);
		Object.defineProperty(audio, 'duration', { value: 179.6, configurable: true });
		await fireEvent(audio, new Event('durationchange'));
		Object.defineProperty(audio, 'currentTime', {
			value: 90.4,
			writable: true,
			configurable: true
		});
		await fireEvent(audio, new Event('timeupdate'));
		expect(screen.getByText('1:30')).toBeTruthy();
		expect(screen.getByText('2:59')).toBeTruthy();
		const slider = screen.getByRole('slider', { name: 'Position in Rain' }) as HTMLInputElement;
		expect(Number(slider.value)).toBeCloseTo(90.4);
	});

	it('picks up a length WebKit sets without saying so', async () => {
		const audio = await loaded();
		// At load: one durationchange, with 0.
		Object.defineProperty(audio, 'duration', { value: 0, configurable: true });
		await fireEvent(audio, new Event('durationchange'));
		const slider = screen.getByRole('slider', { name: 'Position in Rain' }) as HTMLInputElement;
		expect(screen.getAllByText('--:--')).toHaveLength(1);
		expect(slider.disabled).toBe(true);
		expect(Number(slider.value)).toBe(0);

		// Playing: the real length is there, but no durationchange says so.
		Object.defineProperty(audio, 'duration', { value: 30, configurable: true });
		Object.defineProperty(audio, 'currentTime', { value: 2.1, writable: true, configurable: true });
		await fireEvent(audio, new Event('timeupdate'));
		expect(screen.getByText('0:30')).toBeTruthy();
		expect(slider.disabled).toBe(false);
		expect(Number(slider.max)).toBe(30);
		expect(Number(slider.value)).toBeCloseTo(2.1);
	});

	it('plays and pauses from its button, and seeks from the slider', async () => {
		const audio = await loaded();
		const play = vi.spyOn(audio, 'play').mockResolvedValue();
		await fireEvent.click(screen.getByRole('button', { name: 'Play Rain' }));
		expect(play).toHaveBeenCalled();

		Object.defineProperty(audio, 'duration', { value: 100, configurable: true });
		await fireEvent(audio, new Event('durationchange'));
		const slider = screen.getByRole('slider', { name: 'Position in Rain' });
		await fireEvent.input(slider, { target: { value: '42' } });
		expect(audio.currentTime).toBe(42);
	});
});
