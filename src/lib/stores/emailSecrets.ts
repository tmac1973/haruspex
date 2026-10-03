/**
 * Email passwords in the system keychain.
 *
 * Where the operating system has a keychain, an account's password is kept
 * there under `email:<account id>` and the stored account carries only that
 * reference (`passwordRef`) and an empty `password`. Rust reads the password
 * back when it connects; the webview never holds it again. Without a
 * keychain it stays inline in the settings, as it always has.
 */
import { invoke } from '@tauri-apps/api/core';
import { getSettings, setEmailAccounts, type EmailAccount } from './settings';

/** The keychain entry for an account's password. */
export function emailSecretKey(accountId: string): string {
	return `email:${accountId}`;
}

/** Whether this machine has a working keychain. Rust probes once per run. */
export async function keychainAvailable(): Promise<boolean> {
	try {
		return await invoke<boolean>('secret_available');
	} catch {
		return false;
	}
}

/**
 * The account as it should be stored with `password`: in the keychain when
 * there is one, inline otherwise.
 */
export async function withStoredPassword(
	account: EmailAccount,
	password: string
): Promise<EmailAccount> {
	if (!(await keychainAvailable())) {
		return { ...account, password, passwordRef: undefined };
	}
	const key = emailSecretKey(account.id);
	await invoke('secret_set', { key, value: password });
	return { ...account, password: '', passwordRef: key };
}

/** Delete an account's kept password. A failure is logged, never thrown. */
export async function forgetStoredPassword(account: EmailAccount): Promise<void> {
	if (!account.passwordRef) return;
	try {
		await invoke('secret_delete', { key: account.passwordRef });
	} catch (e) {
		console.warn(`Could not delete the kept password for ${account.emailAddress}:`, e);
	}
}

/**
 * Move inline passwords into the keychain. Runs at every start and only
 * touches accounts with an inline password and no reference, so a second run
 * does nothing. An account that fails to move stays as it was.
 */
export async function migrateEmailSecrets(): Promise<void> {
	const inline = getSettings().integrations.email.accounts.filter(
		(a) => a.password && !a.passwordRef
	);
	if (inline.length === 0 || !(await keychainAvailable())) return;

	const moved = new Map<string, { password: string; key: string }>();
	for (const a of inline) {
		const key = emailSecretKey(a.id);
		try {
			await invoke('secret_set', { key, value: a.password });
			moved.set(a.id, { password: a.password, key });
		} catch (e) {
			console.warn(`Could not move the password for ${a.emailAddress} to the keychain:`, e);
		}
	}
	if (moved.size === 0) return;

	// Read the accounts again: one edited while the keychain was busy keeps
	// the edit, and its new password is not cleared.
	setEmailAccounts(
		getSettings().integrations.email.accounts.map((a) => {
			const m = moved.get(a.id);
			return m && a.password === m.password && !a.passwordRef
				? { ...a, password: '', passwordRef: m.key }
				: a;
		})
	);
}
