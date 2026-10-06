/**
 * Inference API keys, kept out of the settings (see `./secrets`).
 *
 * Unlike every other secret these are used by the webview itself: chat
 * requests are the webview's own `fetch`. So each key is stored under
 * `apikey:<id>` and read back into memory (`./apiKeyMemory`) once per run;
 * the settings keep only the key's name and that it is stored. Every request
 * path waits for that load first (`apiKeysReady`), so a request made during
 * startup still carries its key.
 */
import { invoke } from '@tauri-apps/api/core';
import {
	addApiKey,
	deleteApiKey,
	getApiKeys,
	getSettings,
	updateApiKey,
	updateSettings
} from './settings';
import { forgetApiKey, rememberApiKey, rememberedApiKey } from './apiKeyMemory';
import { deleteSecret, keepSecret, secretStoreAvailable, setSecret } from './secrets';
import { getJob, getJobs, loadJobs } from './jobs.svelte';

export function apiKeySecretKey(id: string): string {
	return `apikey:${id}`;
}

let ready: Promise<void> | null = null;

/** Read every stored key into memory, once per run. */
export function apiKeysReady(): Promise<void> {
	ready ??= (async () => {
		for (const k of getApiKeys()) {
			if (!k.stored || rememberedApiKey(k.id) !== undefined) continue;
			try {
				const value = await invoke<string | null>('secret_get', { key: apiKeySecretKey(k.id) });
				if (value) rememberApiKey(k.id, value);
			} catch (e) {
				console.warn(`Could not read the API key "${k.name}":`, e);
			}
		}
	})();
	return ready;
}

async function keep(id: string, value: string): Promise<void> {
	const { inline, ref } = await keepSecret(apiKeySecretKey(id), value);
	if (ref) rememberApiKey(id, value);
	updateApiKey(id, { value: inline, stored: ref !== undefined });
}

/** Add a key and return its id. */
export async function addStoredApiKey(name: string, value: string): Promise<string> {
	const id = addApiKey(name, '');
	await keep(id, value);
	return id;
}

export async function setStoredApiKeyValue(id: string, value: string): Promise<void> {
	await keep(id, value);
}

export async function deleteStoredApiKey(id: string): Promise<void> {
	const k = getApiKeys().find((k) => k.id === id);
	deleteApiKey(id);
	forgetApiKey(id);
	if (k?.stored) await deleteSecret(apiKeySecretKey(id));
}

/**
 * Move inline keys out of the settings, and drop the legacy inline copy of
 * the remote backend's key once it is in the key list. Runs at every start; a
 * no-op once done or where no store works.
 */
export async function migrateApiKeys(): Promise<void> {
	if (!(await secretStoreAvailable())) return;
	for (const k of getApiKeys()) {
		if (!k.value || k.stored) continue;
		try {
			await setSecret(apiKeySecretKey(k.id), k.value);
		} catch (e) {
			console.warn(`Could not move the API key "${k.name}" out of the settings:`, e);
			continue;
		}
		rememberApiKey(k.id, k.value);
		const now = getApiKeys().find((x) => x.id === k.id);
		if (now?.value === k.value) updateApiKey(k.id, { value: '', stored: true });
	}
	const inf = getSettings().inferenceBackend;
	const listed = getApiKeys().find((k) => k.id === inf.remoteApiKeyId);
	if (inf.remoteApiKey && listed?.stored) {
		updateSettings({ inferenceBackend: { ...inf, remoteApiKey: '' } });
	}
}

/**
 * Older jobs keep an inline API key in the database. Move each into the key
 * list (reusing an entry that already holds the same key) and leave the job
 * with only a reference. Runs at every start; a no-op once done.
 *
 * Not covered: a chain stage's model override kept inside a job's
 * type_config. Those are rare, created only by chains set up before keys
 * were referenced by id, and are left as they are.
 */
export async function migrateJobApiKeys(): Promise<void> {
	if (!(await secretStoreAvailable())) return;
	await loadJobs();
	await apiKeysReady();
	for (const summary of getJobs()) {
		const job = await getJob(summary.id);
		const inline = job?.model_remote_api_key?.trim();
		if (!job || !inline || job.model_remote_api_key_id) continue;
		try {
			const existing = getApiKeys().find((k) => (k.value || rememberedApiKey(k.id)) === inline);
			const keyId = existing?.id ?? (await addStoredApiKey(`Job: ${job.name}`, inline));
			await invoke('db_set_job_api_key_ref', { id: job.id, keyId });
		} catch (e) {
			console.warn(`Could not move the API key of job ${job.id} out of the database:`, e);
		}
	}
	await loadJobs();
}

/**
 * A warning for a pasted key value, or null. No provider's API key contains
 * whitespace, so a space means something came along with the key — a label
 * copied from the provider's dashboard, say — and the server will reject it
 * with a 401 that says nothing about why.
 */
export function apiKeyValueWarning(value: string): string | null {
	return /\s/.test(value.trim())
		? 'This contains a space; API keys do not. Paste only the key.'
		: null;
}
