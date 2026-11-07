import { describe, it, expect } from 'vitest';
import { contextResponseFloor, latestUserAudio } from './context';
import { attachedAudioLine } from '#lib/audio/attached.ts';
import type { ChatMessage } from '#lib/api.ts';

describe('contextResponseFloor', () => {
	it('is an eighth of the window', () => {
		expect(contextResponseFloor(32_768)).toBe(4_096);
		expect(contextResponseFloor(65_536)).toBe(8_192);
		expect(contextResponseFloor(100_001)).toBe(12_500);
	});

	it('stops growing at 32K', () => {
		expect(contextResponseFloor(262_144)).toBe(32_768);
		expect(contextResponseFloor(1_000_000)).toBe(32_768);
	});

	it('is nothing for an unknown window', () => {
		expect(contextResponseFloor(0)).toBe(0);
		expect(contextResponseFloor(-1)).toBe(0);
	});
});

describe('latestUserAudio', () => {
	const A = 'a'.repeat(64);
	const B = 'b'.repeat(64);
	it("reads the newest user message's attached audio, in order", () => {
		const messages: ChatMessage[] = [
			{ role: 'user', content: `old\n\n${attachedAudioLine({ name: 'x.mp3', hash: B })}` },
			{ role: 'assistant', content: 'ok' },
			{
				role: 'user',
				content: [
					{
						type: 'text',
						text: `jazz it up\n\n${attachedAudioLine({ name: 'song.wma', hash: A })}\n${attachedAudioLine({ name: 'x.mp3', hash: B })}`
					}
				]
			},
			{ role: 'user', content: 'and louder' }
		];
		expect(latestUserAudio(messages)).toEqual([A, B]);
		expect(latestUserAudio([{ role: 'user', content: 'no audio' }])).toEqual([]);
	});
});
