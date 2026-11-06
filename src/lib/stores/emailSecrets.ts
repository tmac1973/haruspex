/**
 * Email passwords, kept out of the settings under `email:<account id>` (see
 * `./accountSecrets`).
 */
import { getSettings, setEmailAccounts, type EmailAccount } from '#lib/stores/settings.ts';
import { accountSecrets } from '#lib/stores/accountSecrets.ts';

const secrets = accountSecrets<EmailAccount>(
	'email',
	() => getSettings().integrations.email.accounts,
	setEmailAccounts
);

export function emailSecretKey(accountId: string): string {
	return secrets.key(accountId);
}

export function withStoredEmailPassword(
	account: EmailAccount,
	password: string
): Promise<EmailAccount> {
	return secrets.withStoredPassword(account, password);
}

export function forgetEmailPassword(account: EmailAccount): Promise<void> {
	return secrets.forget(account);
}

export function migrateEmailSecrets(): Promise<void> {
	return secrets.migrate();
}
