import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

async function fresh() {
	vi.resetModules();
	return import('./localServerKey.ts');
}

describe('localServerKey', () => {
	beforeEach(() => {
		invoke.mockReset();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	it('reads the key once per run', async () => {
		invoke.mockResolvedValue('abc123');
		const m = await fresh();
		expect(m.localServerKey()).toBeUndefined();
		await m.localServerKeyReady();
		await m.localServerKeyReady();
		expect(m.localServerKey()).toBe('abc123');
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(invoke).toHaveBeenCalledWith('get_llama_api_key');
	});

	it('tries again after a failed read', async () => {
		invoke.mockRejectedValueOnce(new Error('not yet')).mockResolvedValueOnce('later');
		const m = await fresh();
		await m.localServerKeyReady();
		expect(m.localServerKey()).toBeUndefined();
		await m.localServerKeyReady();
		expect(m.localServerKey()).toBe('later');
	});
});
