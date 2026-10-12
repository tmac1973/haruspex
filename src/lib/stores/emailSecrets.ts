/**
 * Email passwords, kept out of the settings (see `./secrets`).
 *
 * An account's password is stored under `email:<account id>` and the stored
 * account carries only that reference (`passwordRef`) and an empty
 * `password`. Rust reads the password back when it connects; the webview
 * never holds it again. Only where no secret store works at all does it stay
 * inline in the settings.
 */
import { getSettings, setEmailAccounts, type EmailAccount } from './settings';
import { deleteSecret, keepSecret, migrateInlineSecrets } from './secrets';

/** The keychain entry for an account's password. */
export function emailSecretKey(accountId: string): string {
	return `email:${accountId}`;
}

/**
 * The account as it should be stored with `password`: in the keychain when
 * there is one, inline otherwise.
 */
export async function withStoredPassword(
	account: EmailAccount,
	password: string
): Promise<EmailAccount> {
	const { inline, ref } = await keepSecret(emailSecretKey(account.id), password);
	return { ...account, password: inline, passwordRef: ref };
}

/** Delete an account's kept password. A failure is logged, never thrown. */
export async function forgetStoredPassword(account: EmailAccount): Promise<void> {
	if (account.passwordRef) await deleteSecret(account.passwordRef);
}

/**
 * Move inline passwords into the keychain. Runs at every start and only
 * touches accounts with an inline password and no reference, so a second run
 * does nothing. An account that fails to move stays as it was.
 */
export function migrateEmailSecrets(): Promise<void> {
	return migrateInlineSecrets<EmailAccount>({
		read: () => getSettings().integrations.email.accounts,
		write: setEmailAccounts,
		inline: (a) => a.password,
		hasRef: (a) => !!a.passwordRef,
		keyFor: (a) => emailSecretKey(a.id),
		moved: (a, key) => ({ ...a, password: '', passwordRef: key })
	});
}
