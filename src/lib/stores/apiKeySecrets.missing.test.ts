import { describe, it, expect, vi, beforeAll } from 'vitest';

// Keys the settings call stored, but the store has nothing for (issue #972)
// or refuses to read. `apiKeysReady` reads once per run, so this file has its
// own module instance. Tests run shuffled, so each that changes a key has
// its own.
const state = vi.hoisted(() => ({ stored: new Map<string, string>() }));

const { unexpectedInvoke } = await vi.hoisted(() => import('#lib/testing/invoke.ts'));

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore(
		{
			secret_set: (a) => void state.stored.set(a!.key as string, a!.value as string),
			secret_get: (a) => {
				if (a!.key === 'apikey:locked') throw 'the keychain is locked';
				return state.stored.get(a!.key as string) ?? null;
			},
			get_llama_api_key: ''
		},
		unexpectedInvoke
	)
);

import { getApiKeyProblem, getApiKeyValue, updateSettings } from './settings';
import { apiKeysReady, setStoredApiKeyValue } from './apiKeySecrets';
import { resolveBackendDescriptor } from '#lib/inference/descriptor.ts';
import { chatCompletion } from '#lib/api.ts';
import { OPENROUTER_BASE_URL } from '#lib/openrouter.ts';

beforeAll(async () => {
	state.stored.set('apikey:present', 'sk-present');
	updateSettings({
		apiKeys: [
			{ id: 'present', name: 'Present', value: '', stored: true },
			{ id: 'gone', name: 'openrouter', value: '', stored: true },
			{ id: 'retyped', name: 'Retyped', value: '', stored: true },
			{ id: 'locked', name: 'Locked', value: '', stored: true }
		]
	});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	await apiKeysReady();
});

describe('a stored key with no value', () => {
	it('is told apart from a key that read back', () => {
		expect(getApiKeyProblem('present')).toBeNull();
		expect(getApiKeyProblem('gone')).toEqual({ name: 'openrouter', problem: 'missing' });
		expect(getApiKeyProblem('locked')).toEqual({ name: 'Locked', problem: 'unreadable' });
	});

	it('gives the backend an error naming the key and where to fix it', () => {
		const d = resolveBackendDescriptor({ baseUrl: OPENROUTER_BASE_URL, apiKeyId: 'gone' });
		expect(d.apiKey).toBeUndefined();
		expect(d.apiKeyError).toBe(
			'The API key "openrouter" is missing from the secret store. Enter it again in Settings → Inference → API Keys.'
		);
		expect(
			resolveBackendDescriptor({ baseUrl: OPENROUTER_BASE_URL, apiKeyId: 'present' }).apiKeyError
		).toBeUndefined();
	});

	it('refuses the request instead of sending it without a key', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network'));
		await expect(
			chatCompletion({
				messages: [{ role: 'user', content: 'hi' }],
				backend: { baseUrl: OPENROUTER_BASE_URL, apiKeyId: 'gone' }
			})
		).rejects.toThrow('The API key "openrouter" is missing from the secret store.');
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});

	it('is fixed by typing the key again', async () => {
		expect(getApiKeyProblem('retyped')?.problem).toBe('missing');
		await setStoredApiKeyValue('retyped', 'sk-or-new');
		expect(getApiKeyProblem('retyped')).toBeNull();
		expect(getApiKeyValue('retyped')).toBe('sk-or-new');
		expect(
			resolveBackendDescriptor({ baseUrl: OPENROUTER_BASE_URL, apiKeyId: 'retyped' }).apiKeyError
		).toBeUndefined();
	});
});
