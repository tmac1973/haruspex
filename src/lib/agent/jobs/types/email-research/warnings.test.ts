import { describe, expect, it } from 'vitest';
import { emailResearchWarnings } from './warnings';

const texts = (phrase: string, provider: Parameters<typeof emailResearchWarnings>[1]) =>
	emailResearchWarnings(phrase, provider).map((w) => w.text);

describe('email research warnings', () => {
	it('warns about a short or one-word phrase', () => {
		expect(texts('ask', 'gmail')).toEqual(['Short phrases are easy to guess.']);
		expect(texts('haruspexresearch', 'gmail')).toEqual(['Short phrases are easy to guess.']);
		expect(texts('ask haruspex', 'gmail')).toEqual([]);
		expect(texts('', 'gmail')).toEqual([]);
	});

	it('warns for providers that may not keep a Sent copy', () => {
		expect(texts('ask haruspex', 'fastmail')).toEqual([]);
		expect(texts('ask haruspex', 'icloud')).toEqual(['Your mail app must save sent mail to Sent.']);
		expect(texts('ask haruspex', 'custom')).toHaveLength(1);
		expect(texts('ask haruspex', null)).toEqual([]);
	});
});
