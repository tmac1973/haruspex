import { describe, expect, it } from 'vitest';
import type { ContactAddress } from '#lib/ipc/gen/ContactAddress.ts';
import { isAddress, mailbox, parseAddresses } from '#lib/stores/emailReview.svelte.ts';
import { completeField, matchContacts, resolveRecipient, typedEntry } from './contacts';

const c = (name: string, email: string): ContactAddress => ({ name, email, accountLabel: 'G' });
const book = [
	c('Sam Lee', 'sam@example.com'),
	c('Samantha Ortiz', 'sortiz@example.com'),
	c('Ana Silva', 'ana@work.example'),
	c('Bob Park', 'bob.samuels@example.com'),
	c('', 'noname@example.com')
];

describe('addresses with names', () => {
	it('splits on commas, but not inside a quoted name or angle brackets', () => {
		expect(parseAddresses('a@x.co; "Lee, Sam" <sam@x.co>, Bob <b@x.co>')).toEqual([
			'a@x.co',
			'"Lee, Sam" <sam@x.co>',
			'Bob <b@x.co>'
		]);
	});

	it('accepts a bare address or a name and an address, and refuses the rest', () => {
		expect(isAddress('sam@x.co')).toBe(true);
		expect(isAddress('Sam Lee <sam@x.co>')).toBe(true);
		expect(isAddress('"Lee, Sam" <sam@x.co>')).toBe(true);
		expect(isAddress('Lee, Sam <sam@x.co>')).toBe(false);
		expect(isAddress('Sam <not an address>')).toBe(false);
		expect(isAddress('Sam Lee')).toBe(false);
	});

	it('quotes a name only when it has to', () => {
		expect(mailbox('Sam Lee', 'sam@x.co')).toBe('Sam Lee <sam@x.co>');
		expect(mailbox('Lee, Sam', 'sam@x.co')).toBe('"Lee, Sam" <sam@x.co>');
		expect(mailbox('Dr. "Q"', 'q@x.co')).toBe('"Dr. \\"Q\\"" <q@x.co>');
		expect(mailbox('', 'sam@x.co')).toBe('sam@x.co');
		expect(isAddress(mailbox('Dr. "Q"', 'q@x.co'))).toBe(true);
	});
});

describe('contact suggestions', () => {
	it('puts names and addresses that start with the text first', () => {
		expect(matchContacts(book, 'sam').map((x) => x.email)).toEqual([
			'sam@example.com',
			'sortiz@example.com',
			'bob.samuels@example.com'
		]);
		expect(matchContacts(book, 'silva').map((x) => x.name)).toEqual(['Ana Silva']);
		expect(matchContacts(book, ' ')).toEqual([]);
		expect(matchContacts(book, 'sam', 2)).toHaveLength(2);
	});

	it('completes the entry being typed and leaves the earlier ones', () => {
		expect(typedEntry('bob@x.co, sa')).toBe('sa');
		expect(completeField('bob@x.co, sa', book[0])).toBe('bob@x.co, Sam Lee <sam@example.com>, ');
		expect(completeField('sa', book[4])).toBe('noname@example.com, ');
	});
});

describe('a recipient the model names', () => {
	it('passes an address through and finds a name', () => {
		expect(resolveRecipient('x@y.co', book)).toBe('x@y.co');
		expect(resolveRecipient('sam lee', book)).toBe('Sam Lee <sam@example.com>');
		expect(resolveRecipient('Ana', book)).toBe('Ana Silva <ana@work.example>');
	});

	it('prefers the exact name over others that start the same', () => {
		expect(resolveRecipient('Sam Lee', [...book, c('Sam Leeds', 'sl@x.co')])).toBe(
			'Sam Lee <sam@example.com>'
		);
	});

	it('names the choices, or says nobody matched', () => {
		expect(() => resolveRecipient('Sam', book)).toThrow(/could be several addresses/);
		expect(() => resolveRecipient('Zed', book)).toThrow(/No contact matches "Zed"/);
	});
});
