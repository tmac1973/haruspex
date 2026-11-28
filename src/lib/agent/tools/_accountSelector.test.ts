import { describe, it, expect } from 'vitest';
import { selectAccounts } from './_accountSelector.ts';

const accounts = [
	{ id: 'a1', label: 'Work', address: 'me@work.example' },
	{ id: 'a2', label: 'Home', address: 'me@home.example' }
];
const pick = (s?: string) => selectAccounts(accounts, s, (a) => a.address).map((a) => a.id);

describe('selectAccounts', () => {
	it('is every account without a selector', () => {
		expect(pick()).toEqual(['a1', 'a2']);
	});

	it('matches the id, then the label, then the address', () => {
		expect(pick('a2')).toEqual(['a2']);
		expect(pick(' work ')).toEqual(['a1']);
		expect(pick('ME@HOME.EXAMPLE')).toEqual(['a2']);
	});

	it('is nothing for a name no account has', () => {
		expect(pick('school')).toEqual([]);
	});
});
