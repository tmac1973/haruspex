import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ available: true, stored: new Map<string, string>() }));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn(async (cmd: string, args?: { key: string; value?: string }) => {
		if (cmd === 'secret_available') return state.available;
		if (cmd === 'secret_set') return void state.stored.set(args!.key, args!.value!);
		if (cmd === 'secret_delete') return void state.stored.delete(args!.key);
		throw new Error(`unexpected invoke: ${cmd}`);
	})
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

	it('stays inline only where no store works', async () => {
		state.available = false;
		await saveBraveApiKey('BSA-123');
		expect(getSettings()).toMatchObject({ braveApiKey: 'BSA-123', braveApiKeySaved: false });
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
