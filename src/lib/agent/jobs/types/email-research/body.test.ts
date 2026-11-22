import { describe, expect, it } from 'vitest';
import { MAX_QUESTION_CHARS, requestQuestion, stripPhrase } from './body';

const subject = 'ask haruspex: e-bikes for hills';
const q = (body: string) => requestQuestion(body, subject, 'Ask Haruspex');

describe('request body', () => {
	it('cuts a Gmail quote, wrapped or not', () => {
		expect(
			q('And for a heavier rider?\n\nOn Sat, 21 Nov 2026 at 10:00, Me <me@x.com> wrote:\n> Earlier')
		).toBe('And for a heavier rider?');
		expect(
			q('And the battery?\n\nOn Sat, 21 Nov 2026 at 10:00, Haruspex <me@x.com\n> wrote:\n> old')
		).toBe('And the battery?');
	});

	it('cuts an Apple Mail quote and drops "Sent from my iPhone"', () => {
		expect(
			q(
				'Which is lightest?\n\nSent from my iPhone\n\nOn 21 Nov 2026, at 10:00, Me <me@x.com> wrote:\n\n> a'
			)
		).toBe('Which is lightest?');
	});

	it('cuts Outlook quotes', () => {
		expect(q('Cheaper ones?\n\n-----Original Message-----\nFrom: me')).toBe('Cheaper ones?');
		expect(
			q('Cheaper ones?\n\n________________________________\nFrom: Me <me@x.com>\nSent: today')
		).toBe('Cheaper ones?');
		expect(q('Cheaper ones?\nFrom: Me <me@x.com>\nSent: Saturday')).toBe('Cheaper ones?');
	});

	it('drops a signature and stray quoted lines', () => {
		expect(q('Find the best one.\n> a stray quote\n-- \nMe\nPhone 123')).toBe('Find the best one.');
	});

	it('falls back to the subject without the phrase, and caps the length', () => {
		expect(q('  \n\n')).toBe('e-bikes for hills');
		expect(q('x'.repeat(MAX_QUESTION_CHARS + 50))).toHaveLength(MAX_QUESTION_CHARS);
	});

	it('strips the phrase and Re: from a subject', () => {
		expect(stripPhrase('Re: ask haruspex: e-bikes', 'ask haruspex')).toBe('e-bikes');
		expect(stripPhrase('Best e-bikes — ASK HARUSPEX', 'ask haruspex')).toBe('Best e-bikes');
		expect(stripPhrase('ask haruspex', 'ask haruspex')).toBe('');
	});
});
