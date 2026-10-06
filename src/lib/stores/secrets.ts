/**
 * Secrets kept out of the settings blob.
 *
 * The settings live in webview storage, where anything that can read the
 * webview can read them. Secrets go to the system keychain instead, or, where
 * none works, to an encrypted file Rust keeps in the app data directory. A
 * stored setting carries only the secret's key; Rust reads the value back when
 * it needs it. See `src-tauri/src/secrets.rs`.
 */
import { invoke } from '@tauri-apps/api/core';

export type SecretStoreKind = 'keychain' | 'file' | 'none';

/** Whether secrets can be kept out of the settings on this machine. */
export async function secretStoreAvailable(): Promise<boolean> {
	try {
		return await invoke<boolean>('secret_available');
	} catch {
		return false;
	}
}

/** Where secrets go here: the keychain, the encrypted file, or nowhere. */
export async function secretStoreKind(): Promise<SecretStoreKind> {
	try {
		return await invoke<SecretStoreKind>('secret_store_kind');
	} catch {
		return 'none';
	}
}

export async function setSecret(key: string, value: string): Promise<void> {
	await invoke('secret_set', { key, value });
}

/** Delete a secret. A failure is logged, never thrown: the setting that
 *  referred to it is going regardless. */
export async function deleteSecret(key: string): Promise<void> {
	try {
		await invoke('secret_delete', { key });
	} catch (e) {
		console.warn(`Could not delete the secret ${key}:`, e);
	}
}

/** Placeholder text for a password field whose value is kept somewhere. */
export function savedSecretPlaceholder(kind: SecretStoreKind): string {
	return kind === 'keychain' ? 'Saved in the system keychain' : 'Saved in Haruspex';
}
