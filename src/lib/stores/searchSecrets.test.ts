import { describe, it, expect, vi, beforeEach } from 'vitest';

const secrets = await vi.hoisted(async () =>
	(await import('#lib/testing/invoke.ts')).fakeSecretStore()
);

const { unexpectedInvoke } = await vi.hoisted(() => import('#lib/testing/invoke.ts'));

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore(secrets.routes, unexpectedInvoke)
);

import { getSettings, hasBraveApiKey, updateSettings } from './settings';
import { migrateBraveApiKey, removeBraveApiKey, saveBraveApiKey } from './searchSecrets';

beforeEach(() => {
	secrets.reset();
	updateSettings({ braveApiKey: '', braveApiKeySaved: false });
});

describe('the Brave key', () => {
	it('is stored out of the settings, which keep only that it exists', async () => {
		await saveBraveApiKey('BSA-123');
		expect(secrets.stored.get('brave:key')).toBe('BSA-123');
		expect(getSettings()).toMatchObject({ braveApiKey: '', braveApiKeySaved: true });
		expect(hasBraveApiKey()).toBe(true);
	});

	it('can be removed', async () => {
		await saveBraveApiKey('BSA-123');
		await removeBraveApiKey();
		expect(secrets.stored.has('brave:key')).toBe(false);
		expect(hasBraveApiKey()).toBe(false);
	});

	it('migrates under its own key', async () => {
		updateSettings({ braveApiKey: 'BSA-old' });
		await migrateBraveApiKey();
		expect(secrets.stored.get('brave:key')).toBe('BSA-old');
	});
});
