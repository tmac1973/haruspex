import { describe, expect, it } from 'vitest';
import { appendPhrase, cleanPhrase, parseDictation, removeAppended } from './dictation';

describe('cleanPhrase', () => {
	it('drops whisper annotations and extra spaces', () => {
		expect(cleanPhrase(' [BLANK_AUDIO] ')).toBe('');
		expect(cleanPhrase('Hello (music)  there')).toBe('Hello there');
	});
});

describe('parseDictation', () => {
	it('ignores nothing but noise', () => {
		expect(parseDictation('[BLANK_AUDIO]')).toEqual({ kind: 'none' });
		expect(parseDictation(' ... ')).toEqual({ kind: 'none' });
	});

	it('hears scratch that, however it is punctuated', () => {
		expect(parseDictation('Scratch that.')).toEqual({ kind: 'scratch' });
		expect(parseDictation('scratch that!')).toEqual({ kind: 'scratch' });
	});

	it('sends when a phrase ends in send it, without the trigger', () => {
		expect(parseDictation('That covers it, send it.')).toEqual({
			kind: 'send',
			text: 'That covers it'
		});
		expect(parseDictation('Send it!')).toEqual({ kind: 'send', text: '' });
	});

	it('leaves send it alone in the middle of a phrase', () => {
		expect(parseDictation('I want to send it to Bob.')).toEqual({
			kind: 'append',
			text: 'I want to send it to Bob.'
		});
	});

	it('does not take a word ending in "send it" as the trigger', () => {
		expect(parseDictation('We resend it')).toEqual({ kind: 'append', text: 'We resend it' });
	});
});

describe('appendPhrase and removeAppended', () => {
	it('puts a space between phrases only when needed', () => {
		expect(appendPhrase('', 'Hi.')).toEqual({ text: 'Hi.', suffix: 'Hi.' });
		expect(appendPhrase('Hi.', 'There.')).toEqual({ text: 'Hi. There.', suffix: ' There.' });
		expect(appendPhrase('Hi.\n', 'There.')).toEqual({ text: 'Hi.\nThere.', suffix: 'There.' });
	});

	it('takes the last phrase back only while the text still ends with it', () => {
		expect(removeAppended('Hi. There.', ' There.')).toBe('Hi.');
		expect(removeAppended('Hi. There!', ' There.')).toBeNull();
		expect(removeAppended('Hi.', '')).toBeNull();
	});
});
