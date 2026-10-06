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

/**
 * Keep `value` under `key` when a store works, and say what the setting
 * should hold: an empty inline value and the key, or — only where no store
 * works — the value itself.
 */
export async function keepSecret(
	key: string,
	value: string
): Promise<{ inline: string; ref: string | undefined }> {
	if (!(await secretStoreAvailable())) return { inline: value, ref: undefined };
	await setSecret(key, value);
	return { inline: '', ref: key };
}

/**
 * Move secrets still held inline in the settings into the store. Runs at
 * every start and touches only items with an inline value and no reference,
 * so a second run does nothing. One that fails to move stays as it was.
 *
 * `read` re-reads the items before writing, so one edited while the store was
 * busy keeps the edit.
 */
export async function migrateInlineSecrets<T extends { id: string }>(opts: {
	read: () => T[];
	write: (items: T[]) => void;
	inline: (item: T) => string;
	hasRef: (item: T) => boolean;
	keyFor: (item: T) => string;
	moved: (item: T, key: string) => T;
}): Promise<void> {
	const pending = opts.read().filter((i) => opts.inline(i) && !opts.hasRef(i));
	if (pending.length === 0 || !(await secretStoreAvailable())) return;

	const moved = new Map<string, { value: string; key: string }>();
	for (const item of pending) {
		const key = opts.keyFor(item);
		try {
			await setSecret(key, opts.inline(item));
			moved.set(item.id, { value: opts.inline(item), key });
		} catch (e) {
			console.warn(`Could not move a secret for ${item.id} out of the settings:`, e);
		}
	}
	if (moved.size === 0) return;
	opts.write(
		opts.read().map((item) => {
			const m = moved.get(item.id);
			return m && opts.inline(item) === m.value && !opts.hasRef(item)
				? opts.moved(item, m.key)
				: item;
		})
	);
}
