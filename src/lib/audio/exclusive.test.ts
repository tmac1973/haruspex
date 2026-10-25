import { describe, it, expect, vi } from 'vitest';
import { installAudioExclusivity } from './exclusive';

describe('installAudioExclusivity', () => {
	it('pauses every other player when one starts, and tells the caller', () => {
		document.body.innerHTML = '<audio id="a"></audio><audio id="b"></audio>';
		const [a, b] = [...document.querySelectorAll('audio')];
		const pauseA = vi.spyOn(a, 'pause').mockImplementation(() => {});
		const pauseB = vi.spyOn(b, 'pause').mockImplementation(() => {});
		// jsdom players never really play; say A is.
		Object.defineProperty(a, 'paused', { value: false });
		const onPlay = vi.fn();
		const remove = installAudioExclusivity(document, onPlay);

		b.dispatchEvent(new Event('play'));
		expect(pauseA).toHaveBeenCalledOnce();
		expect(pauseB).not.toHaveBeenCalled();
		expect(onPlay).toHaveBeenCalledOnce();

		remove();
		b.dispatchEvent(new Event('play'));
		expect(onPlay).toHaveBeenCalledOnce();
	});
});
