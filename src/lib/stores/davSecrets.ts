/**
 * CalDAV/CardDAV passwords, kept out of the settings the way email's are
 * (see `./secrets`). Stored under `dav:<account id>`; Rust reads them back
 * just before connecting.
 */
import { getSettings, setDavAccounts } from './settings';
import type { DavAccount } from '#lib/ipc/gen/DavAccount.ts';
import { deleteSecret, keepSecret, migrateInlineSecrets } from './secrets';

export function davSecretKey(accountId: string): string {
	return `dav:${accountId}`;
}

/** The account as it should be stored with `password`. */
export async function withStoredDavPassword(
	account: DavAccount,
	password: string
): Promise<DavAccount> {
	const { inline, ref } = await keepSecret(davSecretKey(account.id), password);
	return { ...account, password: inline, passwordRef: ref };
}

export async function forgetDavPassword(account: DavAccount): Promise<void> {
	if (account.passwordRef) await deleteSecret(account.passwordRef);
}

export function migrateDavSecrets(): Promise<void> {
	return migrateInlineSecrets<DavAccount>({
		read: () => getSettings().integrations.dav.accounts,
		write: setDavAccounts,
		inline: (a) => a.password,
		hasRef: (a) => !!a.passwordRef,
		keyFor: (a) => davSecretKey(a.id),
		moved: (a, key) => ({ ...a, password: '', passwordRef: key })
	});
}
