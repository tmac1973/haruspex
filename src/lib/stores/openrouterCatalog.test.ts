import { describe, it, expect, beforeEach, vi } from 'vitest';

const fetchCatalog = vi.fn();
vi.mock('#lib/openrouter.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/openrouter.ts')>()),
	fetchOpenRouterCatalog: () => fetchCatalog()
}));

import {
	__resetOpenRouterCatalogForTests,
	ensureOpenRouterCatalog,
	getOpenRouterCatalog,
	isOpenRouterCatalogStale,
	refreshOpenRouterCatalog,
	setOpenRouterCatalog
} from '#lib/stores/openrouterCatalog.svelte.ts';
import { OPENROUTER_CATALOG_TTL_MS, type OpenRouterModel } from '#lib/openrouter.ts';

const model = { id: 'openai/o3', name: 'o3' } as OpenRouterModel;

beforeEach(() => {
	__resetOpenRouterCatalogForTests();
	fetchCatalog.mockReset();
});

describe('OpenRouter catalog store', () => {
	it('starts empty and stale', () => {
		expect(getOpenRouterCatalog()).toBeNull();
		expect(isOpenRouterCatalogStale()).toBe(true);
	});

	it('keeps the catalog out of the shared settings keys', () => {
		setOpenRouterCatalog([model]);
		const keys = Object.keys(localStorage).filter((k) => localStorage.getItem(k)?.includes('o3'));
		expect(keys).toEqual(['openrouter-catalog-cache']);
		expect(keys.some((k) => k.startsWith('haruspex'))).toBe(false);
	});

	it('reads a saved copy back after the in-memory one is gone', () => {
		setOpenRouterCatalog([model], 1000);
		const saved = localStorage.getItem('openrouter-catalog-cache');
		__resetOpenRouterCatalogForTests();
		localStorage.setItem('openrouter-catalog-cache', saved!);
		expect(getOpenRouterCatalog()).toEqual([model]);
		expect(isOpenRouterCatalogStale(1000 + OPENROUTER_CATALOG_TTL_MS)).toBe(false);
		expect(isOpenRouterCatalogStale(1001 + OPENROUTER_CATALOG_TTL_MS)).toBe(true);
	});

	it('ignores a corrupt saved copy', () => {
		localStorage.setItem('openrouter-catalog-cache', '{"models":"no"}');
		expect(getOpenRouterCatalog()).toBeNull();
	});

	it('shares one request between concurrent refreshes', async () => {
		fetchCatalog.mockResolvedValue([model]);
		const [a, b] = await Promise.all([refreshOpenRouterCatalog(), refreshOpenRouterCatalog()]);
		expect(a).toBe(b);
		expect(fetchCatalog).toHaveBeenCalledTimes(1);
		expect(getOpenRouterCatalog()).toEqual([model]);
	});

	it('refreshes only when stale', async () => {
		fetchCatalog.mockResolvedValue([model]);
		setOpenRouterCatalog([model]);
		ensureOpenRouterCatalog();
		expect(fetchCatalog).not.toHaveBeenCalled();

		setOpenRouterCatalog([model], 0);
		ensureOpenRouterCatalog();
		expect(fetchCatalog).toHaveBeenCalledTimes(1);
	});

	it('keeps the old copy when a refresh fails', async () => {
		setOpenRouterCatalog([model], 0);
		fetchCatalog.mockRejectedValue(new Error('offline'));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		ensureOpenRouterCatalog();
		await vi.waitFor(() => expect(warn).toHaveBeenCalled());
		expect(getOpenRouterCatalog()).toEqual([model]);
		warn.mockRestore();
	});
});
