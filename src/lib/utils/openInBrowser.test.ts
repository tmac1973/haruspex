import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { getToasts } from '#lib/stores/toasts.svelte.ts';
import { openInBrowser } from './openInBrowser.ts';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

beforeEach(() => {
	vi.mocked(invoke).mockReset();
});

describe('openInBrowser', () => {
	it('asks Rust to open the address', async () => {
		vi.mocked(invoke).mockResolvedValue(undefined);
		await openInBrowser('https://example.com/a');
		expect(invoke).toHaveBeenCalledWith('open_url', { url: 'https://example.com/a' });
	});

	it('reports a failure as a toast and a redacted log line, without throwing', async () => {
		vi.mocked(invoke).mockRejectedValue('no handler');
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		await expect(openInBrowser('https://example.com/a?token=secret')).resolves.toBeUndefined();
		expect(error).toHaveBeenCalledWith('open_url failed:', 'https://example.com/a', 'no handler');
		expect(getToasts().some((t) => t.message === "Couldn't open link in your browser")).toBe(true);
		error.mockRestore();
	});
});
