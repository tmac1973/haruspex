import { beforeEach, describe, expect, it, vi } from 'vitest';

import { invoke } from '@tauri-apps/api/core';

// One mock for every fresh import: `fresh` resets modules, and each copy of
// localServerKey.ts has to get the `invoke` this test drives.
const tauri = await vi.hoisted(async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
vi.mock('@tauri-apps/api/core', () => tauri);

async function fresh() {
	vi.resetModules();
	return import('./localServerKey.ts');
}

describe('localServerKey', () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	it('reads the key once per run', async () => {
		vi.mocked(invoke).mockResolvedValue('abc123');
		const m = await fresh();
		expect(m.localServerKey()).toBeUndefined();
		await m.localServerKeyReady();
		await m.localServerKeyReady();
		expect(m.localServerKey()).toBe('abc123');
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(invoke).toHaveBeenCalledWith('get_llama_api_key');
	});

	it('tries again after a failed read', async () => {
		vi.mocked(invoke).mockRejectedValueOnce(new Error('not yet')).mockResolvedValueOnce('later');
		const m = await fresh();
		await m.localServerKeyReady();
		expect(m.localServerKey()).toBeUndefined();
		await m.localServerKeyReady();
		expect(m.localServerKey()).toBe('later');
	});
});
