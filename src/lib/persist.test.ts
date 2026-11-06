import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { allInvokeArgs, invokeHandler } from '#lib/testing/invoke.ts';

// One mock for every fresh import: `loadPersist` resets modules, and each
// copy of persist.ts has to get the `invoke` this test drives.
const tauri = await vi.hoisted(async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
vi.mock('@tauri-apps/api/core', () => tauri);

/** A fresh copy of the module, its saved items loaded. */
async function loadPersist() {
	vi.resetModules();
	const persist = await import('./persist.ts');
	await persist.loadSavedItems();
	return persist;
}

describe('persist', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.mocked(invoke).mockReset();
		(globalThis as { isTauri?: boolean }).isTauri = true;
	});
	afterEach(() => {
		delete (globalThis as { isTauri?: boolean }).isTauri;
	});

	it('replaces this origin’s keys with the shared file', async () => {
		localStorage.setItem('haruspex-settings', '{"old":true}');
		localStorage.setItem('haruspex.activeTab', 'jobs');
		localStorage.setItem('unrelated', 'kept');
		vi.mocked(invoke).mockResolvedValueOnce({ 'haruspex-settings': '{"new":true}' });
		await loadPersist();
		expect(localStorage.getItem('haruspex-settings')).toBe('{"new":true}');
		expect(localStorage.getItem('haruspex.activeTab')).toBeNull();
		expect(localStorage.getItem('unrelated')).toBe('kept');
	});

	it('seeds the file from localStorage when there is none', async () => {
		localStorage.setItem('haruspex-settings', '{"a":1}');
		localStorage.setItem('unrelated', 'x');
		vi.mocked(invoke)
			.mockResolvedValueOnce(null)
			.mockImplementationOnce(
				invokeHandler<{ items: Record<string, string> }>((_cmd, args) => args.items)
			);
		await loadPersist();
		expect(invoke).toHaveBeenLastCalledWith('webview_store_seed', {
			items: { 'haruspex-settings': '{"a":1}' }
		});
		expect(localStorage.getItem('haruspex-settings')).toBe('{"a":1}');
	});

	it('keeps localStorage when the file can’t be read', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		localStorage.setItem('haruspex.activeTab', 'code');
		vi.mocked(invoke).mockRejectedValueOnce(new Error('no backend'));
		await loadPersist();
		expect(localStorage.getItem('haruspex.activeTab')).toBe('code');
	});

	it('writes through, in order, newest value per key', async () => {
		vi.mocked(invoke).mockResolvedValueOnce({});
		const { persistItem } = await loadPersist();
		let release = () => {};
		vi.mocked(invoke).mockImplementationOnce(
			invokeHandler(() => new Promise<void>((r) => (release = r)))
		);
		vi.mocked(invoke).mockResolvedValue(undefined);
		persistItem('haruspex.activeTab', 'chat');
		persistItem('haruspex.activeTab', 'jobs');
		persistItem('haruspex.activeTab', 'code');
		expect(localStorage.getItem('haruspex.activeTab')).toBe('code');
		release();
		await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
		const sets = allInvokeArgs<{ value: string }>(vi.mocked(invoke))
			.slice(1)
			.map((a) => a.value);
		expect(sets).toEqual(['chat', 'code']);
	});

	it('only touches localStorage outside Tauri', async () => {
		delete (globalThis as { isTauri?: boolean }).isTauri;
		const { persistItem } = await loadPersist();
		persistItem('haruspex.activeTab', 'chat');
		expect(localStorage.getItem('haruspex.activeTab')).toBe('chat');
		expect(invoke).not.toHaveBeenCalled();
	});
});
