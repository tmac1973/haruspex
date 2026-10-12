/**
 * Passwords for a list of accounts (email, CalDAV/CardDAV), kept out of the
 * settings the way `settingSecret` keeps a single credential. An account's
 * password is stored under `<prefix>:<account id>`, and the stored account
 * carries only that reference (`passwordRef`) and an empty `password`; Rust
 * reads it back when it connects.
 */
import { deleteSecret, keepSecret, migrateInlineSecrets } from '#lib/stores/secrets.ts';

interface PasswordAccount {
	id: string;
	password: string;
	passwordRef?: string;
}

export interface AccountSecrets<T extends PasswordAccount> {
	/** The secret-store key for an account's password. */
	key(accountId: string): string;
	/** The account as it should be stored with `password`. */
	withStoredPassword(account: T, password: string): Promise<T>;
	/** Delete an account's kept password. A failure is logged, never thrown. */
	forget(account: T): Promise<void>;
	/** Move inline passwords into the store. Runs at every start and touches
	 *  only accounts with an inline password and no reference. */
	migrate(): Promise<void>;
}

export function accountSecrets<T extends PasswordAccount>(
	prefix: string,
	read: () => T[],
	write: (accounts: T[]) => void
): AccountSecrets<T> {
	const key = (accountId: string) => `${prefix}:${accountId}`;
	return {
		key,
		async withStoredPassword(account, password) {
			const { inline, ref } = await keepSecret(key(account.id), password);
			return { ...account, password: inline, passwordRef: ref };
		},
		async forget(account) {
			if (account.passwordRef) await deleteSecret(account.passwordRef);
		},
		migrate() {
			return migrateInlineSecrets<T>({
				read,
				write,
				inline: (a) => a.password,
				hasRef: (a) => !!a.passwordRef,
				keyFor: (a) => key(a.id),
				moved: (a, k) => ({ ...a, password: '', passwordRef: k })
			});
		}
	};
}
