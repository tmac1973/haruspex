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

export const davSecretKey = secrets.key;
export const withStoredDavPassword = secrets.withStoredPassword;
export const forgetDavPassword = secrets.forget;
export const migrateDavSecrets = secrets.migrate;
