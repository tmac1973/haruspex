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

export const emailSecretKey = secrets.key;
export const withStoredEmailPassword = secrets.withStoredPassword;
export const forgetEmailPassword = secrets.forget;
export const migrateEmailSecrets = secrets.migrate;
