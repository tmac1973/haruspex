import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import type { ServerModel } from '#lib/rerank.ts';

const state = vi.hoisted(() => ({ config: {} as Record<string, unknown> }));
const listServerModels = vi.hoisted(() => vi.fn());
const setCodeHelperConfig = vi.hoisted(() =>
	vi.fn((id: string, value: unknown) => {
		state.config = { ...state.config, [id]: value };
	})
);
vi.mock('#lib/rerank.ts', () => ({ listServerModels }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: () => ({ codeHelperConfig: state.config }),
		getApiKeys: () => [],
		setCodeHelperConfig
	})
);

import SearchSettings from './SearchSettings.svelte';

const options = () =>
	[...(screen.getByLabelText('Model') as HTMLSelectElement).options].map((o) => o.value);

async function fetchWith(models: ServerModel[]) {
	listServerModels.mockResolvedValueOnce(models);
	render(SearchSettings, { helperId: 'search' });
	await fireEvent.input(screen.getByLabelText('Reranker'), {
		target: { value: 'http://box:3000' }
	});
	await fireEvent.click(screen.getByText('Fetch'));
	await waitFor(() => expect(listServerModels).toHaveBeenCalledWith('http://box:3000', null));
}

beforeEach(() => {
	state.config = {};
	listServerModels.mockReset();
	setCodeHelperConfig.mockClear();
});

describe('SearchSettings', () => {
	it('lists only rerank models when the server reports capabilities', async () => {
		await fetchWith([
			{ id: 'chat', capabilities: ['chat'] },
			{ id: 'reranker', capabilities: ['rerank'] },
			{ id: 'embedder', capabilities: ['embedding'] }
		]);
		await waitFor(() => expect(options()).toEqual(['', 'reranker']));
		expect(state.config.search).toEqual({
			rerank: { url: 'http://box:3000', keyId: null, model: 'reranker' }
		});
	});

	it('lists every model when the server reports none', async () => {
		await fetchWith([
			{ id: 'a', capabilities: null },
			{ id: 'b', capabilities: null }
		]);
		await waitFor(() => expect(options()).toEqual(['', 'a', 'b']));
	});

	it('shows what is stored, and Clear removes it', async () => {
		state.config = { search: { rerank: { url: 'http://box:3000', keyId: null, model: 'r' } } };
		render(SearchSettings, { helperId: 'search' });
		expect((screen.getByLabelText('Reranker') as HTMLInputElement).value).toBe('http://box:3000');
		expect(options()).toEqual(['', 'r']);
		await fireEvent.click(screen.getByText('Clear'));
		expect(state.config.search).toEqual({ rerank: null });
		expect((screen.getByLabelText('Reranker') as HTMLInputElement).value).toBe('');
	});
});
