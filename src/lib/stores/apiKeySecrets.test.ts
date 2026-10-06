import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
	stored: new Map<string, string>(),
	jobs: [] as {
		id: number;
		name: string;
		model_remote_api_key: string | null;
		model_remote_api_key_id: string | null;
	}[],
	refs: [] as { id: number; keyId: string }[]
}));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
		if (cmd === 'secret_available') return true;
		if (cmd === 'secret_set')
			return void state.stored.set(args!.key as string, args!.value as string);
		if (cmd === 'secret_get') return state.stored.get(args!.key as string) ?? null;
		if (cmd === 'secret_delete') return void state.stored.delete(args!.key as string);
		if (cmd === 'db_set_job_api_key_ref') return void state.refs.push(args as never);
		throw new Error(`unexpected invoke: ${cmd}`);
	})
}));

vi.mock('./jobs.svelte', () => ({
	loadJobs: async () => {},
	getJobs: () => state.jobs.map((j) => ({ id: j.id })),
	getJob: async (id: number) => state.jobs.find((j) => j.id === id) ?? null
}));

import { getApiKeyValue, getApiKeys, getSettings, updateSettings } from './settings';
import {
	addStoredApiKey,
	apiKeyValueWarning,
	deleteStoredApiKey,
	migrateApiKeys,
	migrateJobApiKeys,
	setStoredApiKeyValue
} from './apiKeySecrets';

beforeEach(() => {
	state.stored.clear();
	state.jobs = [];
	state.refs = [];
	updateSettings({ apiKeys: [] });
});

describe('inference API keys', () => {
	it('live in the store, with the settings holding only the name', async () => {
		const id = await addStoredApiKey('OpenRouter', 'sk-or-1');
		expect(state.stored.get(`apikey:${id}`)).toBe('sk-or-1');
		expect(getApiKeys()[0]).toMatchObject({ name: 'OpenRouter', value: '', stored: true });
		expect(getApiKeyValue(id)).toBe('sk-or-1');
	});

	it('can be replaced and deleted', async () => {
		const id = await addStoredApiKey('Work', 'old');
		await setStoredApiKeyValue(id, 'new');
		expect(getApiKeyValue(id)).toBe('new');
		await deleteStoredApiKey(id);
		expect(state.stored.has(`apikey:${id}`)).toBe(false);
		expect(getApiKeyValue(id)).toBeUndefined();
	});

	it('move out of the settings at startup, and so does the legacy inline backend key', async () => {
		updateSettings({
			apiKeys: [{ id: 'k1', name: 'Migrated', value: 'sk-old' }],
			inferenceBackend: {
				...getSettings().inferenceBackend,
				remoteApiKey: 'sk-old',
				remoteApiKeyId: 'k1'
			}
		});
		await migrateApiKeys();
		expect(state.stored.get('apikey:k1')).toBe('sk-old');
		expect(getApiKeys()[0]).toMatchObject({ value: '', stored: true });
		expect(getSettings().inferenceBackend.remoteApiKey).toBe('');
		expect(getApiKeyValue('k1')).toBe('sk-old');
	});
});

describe('migrateJobApiKeys', () => {
	it('moves a job inline key into the list, reusing a matching entry', async () => {
		const id = await addStoredApiKey('Shared', 'sk-same');
		state.jobs = [
			{ id: 1, name: 'Audit', model_remote_api_key: 'sk-same', model_remote_api_key_id: null },
			{ id: 2, name: 'Digest', model_remote_api_key: 'sk-other', model_remote_api_key_id: null },
			{ id: 3, name: 'Done', model_remote_api_key: null, model_remote_api_key_id: 'x' }
		];
		await migrateJobApiKeys();
		expect(state.refs).toHaveLength(2);
		expect(state.refs[0]).toEqual({ id: 1, keyId: id });
		const created = getApiKeys().find((k) => k.name === 'Job: Digest');
		expect(created?.stored).toBe(true);
		expect(state.refs[1]).toEqual({ id: 2, keyId: created!.id });
	});
});

describe('apiKeyValueWarning', () => {
	it('flags a value with a space in it, such as a label pasted with the key', () => {
		expect(apiKeyValueWarning('coding - sk-or-v1-abc')).toMatch(/space/);
		expect(apiKeyValueWarning('sk-or-v1-abc\tdef')).toMatch(/space/);
	});

	it('accepts a plain key, ignoring surrounding whitespace', () => {
		expect(apiKeyValueWarning('sk-or-v1-abc')).toBeNull();
		expect(apiKeyValueWarning('  sk-or-v1-abc \n')).toBeNull();
		expect(apiKeyValueWarning('')).toBeNull();
	});
});
