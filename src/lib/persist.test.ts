import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

/** A fresh copy of the module, so its top-level load runs again. */
async function loadPersist() {
	vi.resetModules();
	return import('./persist.ts');
}

describe('persist', () => {
	beforeEach(() => {
		localStorage.clear();
		invoke.mockReset();
		(globalThis as { isTauri?: boolean }).isTauri = true;
	});
	afterEach(() => {
		delete (globalThis as { isTauri?: boolean }).isTauri;
	});

	it('replaces this origin’s keys with the shared file', async () => {
		localStorage.setItem('haruspex-settings', '{"old":true}');
		localStorage.setItem('haruspex.activeTab', 'jobs');
		localStorage.setItem('unrelated', 'kept');
		invoke.mockResolvedValueOnce({ 'haruspex-settings': '{"new":true}' });
		await loadPersist();
		expect(localStorage.getItem('haruspex-settings')).toBe('{"new":true}');
		expect(localStorage.getItem('haruspex.activeTab')).toBeNull();
		expect(localStorage.getItem('unrelated')).toBe('kept');
	});

	it('seeds the file from localStorage when there is none', async () => {
		localStorage.setItem('haruspex-settings', '{"a":1}');
		localStorage.setItem('unrelated', 'x');
		invoke.mockResolvedValueOnce(null).mockImplementationOnce((_cmd, args) => args.items);
		await loadPersist();
		expect(invoke).toHaveBeenLastCalledWith('webview_store_seed', {
			items: { 'haruspex-settings': '{"a":1}' }
		});
		expect(localStorage.getItem('haruspex-settings')).toBe('{"a":1}');
	});

	it('keeps localStorage when the file can’t be read', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		localStorage.setItem('haruspex.activeTab', 'code');
		invoke.mockRejectedValueOnce(new Error('no backend'));
		await loadPersist();
		expect(localStorage.getItem('haruspex.activeTab')).toBe('code');
	});

	it('writes through, in order, newest value per key', async () => {
		invoke.mockResolvedValueOnce({});
		const { persistItem } = await loadPersist();
		let release = () => {};
		invoke.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
		invoke.mockResolvedValue(undefined);
		persistItem('haruspex.activeTab', 'chat');
		persistItem('haruspex.activeTab', 'jobs');
		persistItem('haruspex.activeTab', 'code');
		expect(localStorage.getItem('haruspex.activeTab')).toBe('code');
		release();
		await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
		const sets = invoke.mock.calls.slice(1).map((c) => c[1].value);
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
