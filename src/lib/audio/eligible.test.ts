import { describe, it, expect } from 'vitest';
import type { SearchStep } from '#lib/agent/loop.ts';
import { audioHashesInText, placeGeneratedAudio } from './eligible';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const line = (h: string, title = 'Song') => `![${title}](haruspex-audio://localhost/${h})`;

function step(toolName: string, result: string): SearchStep {
	return { id: toolName, toolName, query: '', status: 'done', result } as SearchStep;
}

describe('placeGeneratedAudio', () => {
	const tools = ['generate_music'];

	it('appends a song the answer left out, once', () => {
		const steps = [step('generate_music', `Made it. Put ${line(A)} in your answer.`)];
		const out = placeGeneratedAudio('Here you go.', steps, tools);
		expect(out).toBe(`Here you go.\n\n${line(A)}`);
		expect(placeGeneratedAudio(out, steps, tools)).toBe(out);
	});

	it('leaves an answer that already plays it alone', () => {
		const steps = [step('generate_music', line(A))];
		const text = `Listen: ${line(A, 'Rain')}`;
		expect(placeGeneratedAudio(text, steps, tools)).toBe(text);
	});

	it('ignores tools not listed, and links that are not ours', () => {
		const steps = [
			step('fetch_url', line(B)),
			step('generate_music', '![x](https://example.com/a.mp3)')
		];
		expect(placeGeneratedAudio('Hi.', steps, tools)).toBe('Hi.');
	});

	it('covers generate_music by default', () => {
		expect(placeGeneratedAudio('Hi.', [step('generate_music', line(A))])).toBe(`Hi.\n\n${line(A)}`);
	});
});

describe('audioHashesInText', () => {
	it('finds each cached file a message plays, once', () => {
		expect(
			audioHashesInText([`${line(A)} and ${line(B)}`, line(A), '![p](haruspex-img://localhost/x)'])
		).toEqual([A, B]);
	});
});
