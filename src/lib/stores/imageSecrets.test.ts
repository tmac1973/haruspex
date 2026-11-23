import { describe, it, expect, vi, beforeEach } from 'vitest';

const secrets = await vi.hoisted(async () =>
	(await import('#lib/testing/invoke.ts')).fakeSecretStore()
);

const { unexpectedInvoke } = await vi.hoisted(() => import('#lib/testing/invoke.ts'));

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore(secrets.routes, unexpectedInvoke)
);

import { getSettings, updateSettings } from './settings';
import { comfyApiKey } from './imageSecrets';

beforeEach(() => {
	secrets.reset();
	updateSettings({ imageBackendApiKey: '', imageBackendApiKeySaved: false });
});

describe('the ComfyUI API key', () => {
	it('moves out of the settings at startup and stays configured', async () => {
		updateSettings({ imageBackendApiKey: 'sk-comfy' });
		await comfyApiKey.migrate();
		expect(secrets.stored.get('comfy:key')).toBe('sk-comfy');
		expect(getSettings()).toMatchObject({
			imageBackendApiKey: '',
			imageBackendApiKeySaved: true
		});
		expect(comfyApiKey.configured()).toBe(true);
	});

	it('is gone after removal', async () => {
		await comfyApiKey.save('sk-comfy');
		await comfyApiKey.remove();
		expect(secrets.stored.has('comfy:key')).toBe(false);
		expect(comfyApiKey.configured()).toBe(false);
	});
});
