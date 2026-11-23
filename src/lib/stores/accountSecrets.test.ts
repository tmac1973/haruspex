import { describe, it, expect, vi, beforeEach } from 'vitest';

const secrets = await vi.hoisted(async () =>
	(await import('#lib/testing/invoke.ts')).fakeSecretStore()
);
const { unexpectedInvoke } = await vi.hoisted(() => import('#lib/testing/invoke.ts'));

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore(secrets.routes, unexpectedInvoke)
);

import { accountSecrets } from './accountSecrets';

interface Account {
	id: string;
	name: string;
	password: string;
	passwordRef?: string;
}

let accounts: Account[] = [];
const accountSecretsUnderTest = accountSecrets<Account>(
	'test',
	() => accounts,
	(next) => (accounts = next)
);
const realSet = secrets.routes.secret_set;

beforeEach(() => {
	secrets.reset();
	accounts = [];
});

describe('accountSecrets', () => {
	it("keys a password by the account's id", () => {
		expect(accountSecretsUnderTest.key('a1')).toBe('test:a1');
	});

	it('stores the password and keeps only its reference on the account', async () => {
		const account = { id: 'a1', name: 'Work', password: '' };
		const stored = await accountSecretsUnderTest.withStoredPassword(account, 'hunter2');
		expect(stored).toEqual({ id: 'a1', name: 'Work', password: '', passwordRef: 'test:a1' });
		expect(secrets.stored.get('test:a1')).toBe('hunter2');
	});

	it('forgets a kept password, and leaves an account without one alone', async () => {
		secrets.stored.set('test:a1', 'hunter2');
		await accountSecretsUnderTest.forget({
			id: 'a1',
			name: 'Work',
			password: '',
			passwordRef: 'test:a1'
		});
		expect(secrets.stored.size).toBe(0);
		await accountSecretsUnderTest.forget({ id: 'a2', name: 'Home', password: '' });
	});

	describe('migrate', () => {
		it('moves inline passwords and skips accounts that already have a reference', async () => {
			accounts = [
				{ id: 'a1', name: 'Work', password: 'inline' },
				{ id: 'a2', name: 'Home', password: '', passwordRef: 'test:a2' },
				{ id: 'a3', name: 'Old', password: '' }
			];
			await accountSecretsUnderTest.migrate();
			expect([...secrets.stored]).toEqual([['test:a1', 'inline']]);
			expect(accounts).toEqual([
				{ id: 'a1', name: 'Work', password: '', passwordRef: 'test:a1' },
				{ id: 'a2', name: 'Home', password: '', passwordRef: 'test:a2' },
				{ id: 'a3', name: 'Old', password: '' }
			]);
		});

		it('leaves an account as it was when the store refuses its password', async () => {
			accounts = [{ id: 'a1', name: 'Work', password: 'inline' }];
			secrets.refuseSet = true;
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			await accountSecretsUnderTest.migrate();
			expect(accounts).toEqual([{ id: 'a1', name: 'Work', password: 'inline' }]);
			warn.mockRestore();
		});

		it('does nothing where no store works', async () => {
			accounts = [{ id: 'a1', name: 'Work', password: 'inline' }];
			secrets.available = false;
			await accountSecretsUnderTest.migrate();
			expect(accounts[0].password).toBe('inline');
			expect(secrets.stored.size).toBe(0);
		});

		it('keeps a password the user changed while it was moving', async () => {
			accounts = [{ id: 'a1', name: 'Work', password: 'inline' }];
			secrets.routes.secret_set = (a) => {
				accounts = [{ id: 'a1', name: 'Work', password: 'changed' }];
				return realSet(a);
			};
			try {
				await accountSecretsUnderTest.migrate();
			} finally {
				secrets.routes.secret_set = realSet;
			}
			expect(accounts).toEqual([{ id: 'a1', name: 'Work', password: 'changed' }]);
		});
	});
});
