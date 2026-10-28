/**
 * Settings, for clients other than the Settings panel: read them, and change
 * the ones a test or a remote setup needs, without stopping the app to edit
 * its store. Main window only, and only for a device with the `settings`
 * scope (`src-tauri/src/owner/clients.rs`).
 *
 * Secrets never cross: a read blanks them and says where, and a patch that
 * names one is refused. So are the settings that decide who reaches this
 * computer or what it runs on its own (Remote control, guest chat, the MCP
 * servers and accounts): those are changed in Settings, on the computer.
 *
 * A value is read where it is used, so most changes apply at the next turn.
 * One that Settings applies by starting or stopping something (the model
 * server, the bundled image engine) isn't applied by this.
 */
import { getSettings, updateSettings, type AppSettings } from '#lib/stores/settings.ts';

/** A field holding a secret, wherever it sits: `braveApiKey`, `remoteAccessToken`, a password. */
const SECRET_KEY = /(api_?key|token|password)$/i;

/** Objects whose every value is a secret: an MCP server's `secrets`. */
const SECRET_MAPS = new Set(['secrets']);

/**
 * Top-level settings a patch may not touch. The API-key store and the
 * integrations hold secrets; the rest decide who can reach this computer.
 */
const REFUSED = [
	{ test: (k: string) => k === 'apiKeys', where: 'Settings → Inference → API Keys' },
	{ test: (k: string) => k === 'integrations', where: 'Settings → Integrations' },
	{ test: (k: string) => k.startsWith('ownerApi'), where: 'Settings → Remote control' },
	{ test: (k: string) => k.startsWith('remoteAccess'), where: 'Settings → Guest chat' }
];

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const isObject = (v: unknown): v is Record<string, Json> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A plain copy with every secret blanked, and the paths that were blanked.
 * Only strings that are set count: an empty one hides nothing.
 */
export function redactSecrets(value: unknown): { value: Json; redacted: string[] } {
	const redacted: string[] = [];
	const walk = (v: Json, path: string, key: string, inApiKeys: boolean): Json => {
		if (typeof v === 'string') {
			const secret = SECRET_KEY.test(key) || (inApiKeys && key === 'value');
			if (secret && v !== '') {
				redacted.push(path);
				return '';
			}
			return v;
		}
		if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`, key, inApiKeys));
		if (isObject(v)) {
			const out: Record<string, Json> = {};
			for (const [k, x] of Object.entries(v)) {
				const at = path ? `${path}.${k}` : k;
				if (SECRET_MAPS.has(k) && isObject(x)) {
					out[k] = Object.fromEntries(
						Object.entries(x).map(([name, s]) => {
							if (typeof s === 'string' && s !== '') {
								redacted.push(`${at}.${name}`);
								return [name, ''];
							}
							return [name, s];
						})
					);
					continue;
				}
				out[k] = walk(x, at, k, inApiKeys || (path === '' && k === 'apiKeys'));
			}
			return out;
		}
		return v;
	};
	const plain = JSON.parse(JSON.stringify(value ?? null)) as Json;
	return { value: walk(plain, '', '', false), redacted };
}

/** The settings, secrets blanked; `keys` picks top-level settings. */
export function readSettings(keys?: string[]): { settings: Json; redacted: string[] } {
	const all = getSettings() as unknown as Record<string, unknown>;
	if (keys?.length) {
		const unknown = keys.filter((k) => !(k in all));
		if (unknown.length) throw new Error(`no such setting: ${unknown.join(', ')}`);
	}
	const picked = keys?.length ? Object.fromEntries(keys.map((k) => [k, all[k]])) : all;
	const { value, redacted } = redactSecrets(picked);
	return { settings: value, redacted };
}

const kind = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/**
 * `patch` laid over `current`: objects merged key by key, anything else
 * replaced. Throws on a key `current` hasn't got, on a secret, and on a value
 * of another type than the one it replaces (null fits any).
 */
export function mergePatch(current: Json, patch: Json, path: string): Json {
	if (!isObject(patch) || !isObject(current)) {
		if (current !== null && patch !== null && kind(current) !== kind(patch)) {
			throw new Error(`${path} takes ${a(kind(current))}, not ${a(kind(patch))}`);
		}
		return patch;
	}
	const out: Record<string, Json> = { ...current };
	for (const [k, v] of Object.entries(patch)) {
		const at = path ? `${path}.${k}` : k;
		if (SECRET_KEY.test(k) || SECRET_MAPS.has(k)) {
			throw new Error(`${at} is a secret: set it in Settings on the computer`);
		}
		if (!(k in current)) throw new Error(`no such setting: ${at}`);
		out[k] = mergePatch(current[k], v, at);
	}
	return out;
}

const a = (k: string) => (/^[aeiou]/.test(k) ? `an ${k}` : `a ${k}`);

/** Lay `patch` over the settings and save them. What changed, by top-level key. */
export function patchSettings(patch: unknown): { changed: string[] } {
	if (!isObject(patch)) throw new Error('settings.patch takes an object of settings');
	for (const key of Object.keys(patch)) {
		const refused = REFUSED.find((r) => r.test(key));
		if (refused) throw new Error(`${key} can't be changed remotely: use ${refused.where}`);
	}
	const current = JSON.parse(JSON.stringify(getSettings())) as Record<string, Json>;
	const merged = mergePatch(current, patch, '') as Record<string, Json>;
	const changed = Object.keys(patch).filter(
		(k) => JSON.stringify(merged[k]) !== JSON.stringify(current[k])
	);
	if (changed.length) {
		updateSettings(Object.fromEntries(changed.map((k) => [k, merged[k]])) as Partial<AppSettings>);
	}
	return { changed };
}
