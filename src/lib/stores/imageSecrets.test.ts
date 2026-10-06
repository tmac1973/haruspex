import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ stored: new Map<string, string>() }));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn(async (cmd: string, args?: { key: string; value?: string }) => {
		if (cmd === 'secret_available') return true;
		if (cmd === 'secret_set') return void state.stored.set(args!.key, args!.value!);
		if (cmd === 'secret_delete') return void state.stored.delete(args!.key);
		throw new Error(`unexpected invoke: ${cmd}`);
	})
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
