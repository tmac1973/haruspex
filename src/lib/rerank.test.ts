import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

const { getApiKeyValueMock, apiKeysReadyMock } = vi.hoisted(() => ({
	getApiKeyValueMock: vi.fn<(id: string | null | undefined) => string | undefined>(),
	apiKeysReadyMock: vi.fn(() => Promise.resolve())
}));
vi.mock('#lib/stores/settings.ts', () => ({ getApiKeyValue: getApiKeyValueMock }));
vi.mock('#lib/stores/apiKeySecrets.ts', () => ({ apiKeysReady: apiKeysReadyMock }));

import { listServerModels, rerankDocuments } from './rerank.ts';

beforeEach(() => {
	vi.mocked(invoke).mockReset();
	getApiKeyValueMock.mockReset();
	getApiKeyValueMock.mockImplementation((id) => (id === 'k1' ? 'sk-secret' : undefined));
	apiKeysReadyMock.mockClear();
});

describe('rerankDocuments', () => {
	it('resolves the key id and passes the args through', async () => {
		vi.mocked(invoke).mockResolvedValue({ order: [{ index: 1, score: 0.9 }] });
		const got = await rerankDocuments(
			{ url: 'http://compute2:3000', keyId: 'k1', model: 'rr' },
			'where is loopback',
			['a', 'b'],
			5000
		);
		expect(got.order[0].index).toBe(1);
		expect(apiKeysReadyMock).toHaveBeenCalled();
		expect(invoke).toHaveBeenCalledWith('rerank_run', {
			baseUrl: 'http://compute2:3000',
			apiKey: 'sk-secret',
			model: 'rr',
			query: 'where is loopback',
			documents: ['a', 'b'],
			timeoutMs: 5000
		});
	});

	it('sends no key and the default timeout when none is set', async () => {
		vi.mocked(invoke).mockResolvedValue({ order: [] });
		await rerankDocuments({ url: 'http://h', keyId: null, model: 'rr' }, 'q', []);
		expect(invoke).toHaveBeenCalledWith(
			'rerank_run',
			expect.objectContaining({ apiKey: null, timeoutMs: null })
		);
	});
});

describe('listServerModels', () => {
	it('resolves the key id and passes the url through', async () => {
		const models = [{ id: 'rr', capabilities: ['rerank'] }];
		vi.mocked(invoke).mockResolvedValue(models);
		expect(await listServerModels('http://compute2:3000', 'k1')).toEqual(models);
		expect(apiKeysReadyMock).toHaveBeenCalled();
		expect(invoke).toHaveBeenCalledWith('server_models_list', {
			baseUrl: 'http://compute2:3000',
			apiKey: 'sk-secret'
		});
	});

	it('sends no key for an unknown key id', async () => {
		vi.mocked(invoke).mockResolvedValue([]);
		await listServerModels('http://h', 'gone');
		expect(invoke).toHaveBeenCalledWith('server_models_list', {
			baseUrl: 'http://h',
			apiKey: null
		});
	});
});
