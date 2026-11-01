import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ available: true, stored: new Map<string, string>() }));

const { invokeRouter, unexpectedInvoke } = await vi.hoisted(() => import('#lib/testing/invoke.ts'));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn(
		invokeRouter(
			{
				secret_available: () => state.available,
				secret_set: (a) => void state.stored.set(a!.key as string, a!.value as string),
				secret_delete: (a) => void state.stored.delete(a!.key as string)
			},
			unexpectedInvoke
		)
	)
}));

import { getSettings, hasBraveApiKey, updateSettings } from './settings';
import { migrateBraveApiKey, removeBraveApiKey, saveBraveApiKey } from './searchSecrets';

beforeEach(() => {
	state.available = true;
	state.stored.clear();
	updateSettings({ braveApiKey: '', braveApiKeySaved: false });
});

describe('the Brave key', () => {
	it('is stored out of the settings, which keep only that it exists', async () => {
		await saveBraveApiKey('BSA-123');
		expect(state.stored.get('brave:key')).toBe('BSA-123');
		expect(getSettings()).toMatchObject({ braveApiKey: '', braveApiKeySaved: true });
		expect(hasBraveApiKey()).toBe(true);
	});

	it('never stays in the settings, even where nothing lasts', async () => {
		// Rust keeps it in memory for the session then.
		state.available = false;
		await saveBraveApiKey('BSA-123');
		expect(getSettings()).toMatchObject({ braveApiKey: '', braveApiKeySaved: true });
		expect(state.stored.get('brave:key')).toBe('BSA-123');
		expect(hasBraveApiKey()).toBe(true);
	});

	it('can be removed', async () => {
		await saveBraveApiKey('BSA-123');
		await removeBraveApiKey();
		expect(state.stored.has('brave:key')).toBe(false);
		expect(hasBraveApiKey()).toBe(false);
	});

	it('moves out of the settings at startup', async () => {
		updateSettings({ braveApiKey: 'BSA-old' });
		await migrateBraveApiKey();
		expect(state.stored.get('brave:key')).toBe('BSA-old');
		expect(getSettings()).toMatchObject({ braveApiKey: '', braveApiKeySaved: true });
	});
});
