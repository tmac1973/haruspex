/**
 * Proxy passwords, kept out of the settings (see `./secrets`).
 *
 * A proxy URL typed as `http://user:pass@host:port` is stored as
 * `http://user@host:port` with the password under `proxy:network` or
 * `proxy:search`; Rust puts it back when it builds a proxied client. Only
 * where no secret store works does the URL keep its password.
 */
import { getSettings, updateProxy, updateSearchProxy } from './settings';
import { deleteSecret, keepSecret, secretStoreAvailable, setSecret } from './secrets';

export type WhichProxy = 'network' | 'search';

export function proxySecretKey(which: WhichProxy): string {
	return `proxy:${which}`;
}

function current(which: WhichProxy): { url: string; passwordRef?: string } {
	const s = getSettings();
	return which === 'network' ? s.proxy : s.searchProxy;
}

function write(which: WhichProxy, patch: { url: string; passwordRef: string | undefined }): void {
	if (which === 'network') updateProxy(patch);
	else updateSearchProxy(patch);
}

/** `raw` without its password, and the password, decoded. */
export function splitPassword(raw: string): { url: string; password: string } {
	try {
		const u = new URL(raw);
		if (!u.password) return { url: raw, password: '' };
		const password = decodeURIComponent(u.password);
		u.password = '';
		return { url: u.toString().replace(/\/$/, raw.endsWith('/') ? '/' : ''), password };
	} catch {
		return { url: raw, password: '' };
	}
}

/**
 * Save a proxy URL as the user typed it. A password in it goes to the store.
 * A URL without one keeps the saved password while it still points at the
 * same proxy as the user, so editing the bypass list or re-focusing the field
 * does not lose it; pointing it anywhere else forgets it.
 */
export async function saveProxyUrl(which: WhichProxy, raw: string): Promise<void> {
	const typed = raw.trim();
	const { url, password } = splitPassword(typed);
	const before = current(which);
	if (password) {
		const { inline, ref } = await keepSecret(proxySecretKey(which), password);
		write(which, ref ? { url, passwordRef: ref } : { url: typed, passwordRef: undefined });
		void inline;
		return;
	}
	if (before.passwordRef && url === before.url) return;
	if (before.passwordRef) await deleteSecret(before.passwordRef);
	write(which, { url, passwordRef: undefined });
}

/** Move a password still inside a stored proxy URL out of the settings. */
export async function migrateProxyPasswords(): Promise<void> {
	if (!(await secretStoreAvailable())) return;
	for (const which of ['network', 'search'] as const) {
		const before = current(which);
		const { url, password } = splitPassword(before.url);
		if (!password || before.passwordRef) continue;
		try {
			await setSecret(proxySecretKey(which), password);
		} catch (e) {
			console.warn(`Could not move the ${which} proxy password out of the settings:`, e);
			continue;
		}
		if (current(which).url === before.url) {
			write(which, { url, passwordRef: proxySecretKey(which) });
		}
	}
}
