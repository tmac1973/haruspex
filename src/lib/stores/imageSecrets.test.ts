import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ stored: new Map<string, string>() }));

const { invokeRouter, unexpectedInvoke } = await vi.hoisted(() => import('#lib/testing/invoke.ts'));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn(
		invokeRouter(
			{
				secret_available: true,
				secret_set: (a) => void state.stored.set(a!.key as string, a!.value as string),
				secret_delete: (a) => void state.stored.delete(a!.key as string)
			},
			unexpectedInvoke
		)
	)
}));

import { getSettings, updateSettings } from './settings';
import { comfyApiKey } from './imageSecrets';

beforeEach(() => {
	state.stored.clear();
	updateSettings({ imageBackendApiKey: '', imageBackendApiKeySaved: false });
});

describe('the ComfyUI API key', () => {
	it('moves out of the settings at startup and stays configured', async () => {
		updateSettings({ imageBackendApiKey: 'sk-comfy' });
		await comfyApiKey.migrate();
		expect(state.stored.get('comfy:key')).toBe('sk-comfy');
		expect(getSettings()).toMatchObject({
			imageBackendApiKey: '',
			imageBackendApiKeySaved: true
		});
		expect(comfyApiKey.configured()).toBe(true);
	});

	it('is gone after removal', async () => {
		await comfyApiKey.save('sk-comfy');
		await comfyApiKey.remove();
		expect(state.stored.has('comfy:key')).toBe(false);
		expect(comfyApiKey.configured()).toBe(false);
	});
});
