import { describe, expect, it } from 'vitest';
import { emailCardAccounts } from './emailCard.ts';

const accounts = [
	{ id: 'w', emailAddress: 'tim@work.example', label: 'Work' },
	{ id: 'p', emailAddress: 'tim@home.example', label: 'Personal' },
	{ id: 'x', emailAddress: '', label: 'No address' }
];
const config = (ids: string[]) => JSON.stringify({ accountIds: ids, rule: 'r' });

describe('emailCardAccounts', () => {
	it('names the account a job reads by its address', () => {
		expect(emailCardAccounts(config(['p']), accounts)).toBe('tim@home.example');
	});

	it('lists several accounts in the job’s order', () => {
		expect(emailCardAccounts(config(['p', 'w']), accounts)).toBe(
			'tim@home.example, tim@work.example'
		);
	});

	it('falls back to the label when an account has no address', () => {
		expect(emailCardAccounts(config(['x']), accounts)).toBe('No address');
	});

	it('leaves out removed accounts, and is null when none is left', () => {
		expect(emailCardAccounts(config(['gone', 'w']), accounts)).toBe('tim@work.example');
		expect(emailCardAccounts(config(['gone']), accounts)).toBeNull();
		expect(emailCardAccounts(null, accounts)).toBeNull();
	});
});
