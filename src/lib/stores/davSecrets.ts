/**
 * CalDAV/CardDAV passwords, links and refresh tokens, kept out of the
 * settings under `dav:<account id>` (see `./accountSecrets`). Rust's
 * `dav::account::secret_key` names the same key.
 */
import { getSettings, setDavAccounts } from '#lib/stores/settings.ts';
import type { DavAccount } from '#lib/ipc/gen/DavAccount.ts';
import { accountSecrets } from '#lib/stores/accountSecrets.ts';

const secrets = accountSecrets<DavAccount>(
	'dav',
	() => getSettings().integrations.dav.accounts,
	setDavAccounts
);

export function davSecretKey(accountId: string): string {
	return secrets.key(accountId);
}

export function withStoredDavPassword(account: DavAccount, password: string): Promise<DavAccount> {
	return secrets.withStoredPassword(account, password);
}

export function forgetDavPassword(account: DavAccount): Promise<void> {
	return secrets.forget(account);
}

export function migrateDavSecrets(): Promise<void> {
	return secrets.migrate();
}
