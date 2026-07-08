import { describe, it, expect } from 'vitest';
import {
	parseOpenRouterCatalog,
	parseOpenRouterKeyStatus,
	isOpenRouterFreeModel,
	isOpenRouterToolCapable,
	isOpenRouterVisionCapable,
	OPENROUTER_CATALOG_TTL_MS,
	FREE_MODEL_RPM,
	type OpenRouterModel
} from '$lib/openrouter';

const toolModel = (id: string, name: string): OpenRouterModel => ({
	id,
	name,
	context_length: 128000,
	architecture: { input_modalities: ['text'], output_modalities: ['text'] },
	supported_parameters: ['tools', 'temperature', 'top_p'],
	pricing: { prompt: '0', completion: '0', request: '0' },
	expiration_date: null
});

describe('parseOpenRouterCatalog', () => {
	it('parses a populated data array and sorts by name', () => {
		const data = {
			data: [
				{ id: 'anthropic/claude-sonnet', name: 'Claude Sonnet', context_length: 200000 },
				{ id: 'openai/gpt-4o', name: 'GPT-4o', context_length: 128000 }
			]
		};
		const models = parseOpenRouterCatalog(data);
		expect(models).toHaveLength(2);
		expect(models[0].name).toBe('Claude Sonnet');
		expect(models[1].name).toBe('GPT-4o');
		expect(models[0].context_length).toBe(200000);
	});

	it('extracts reasoning caps when present', () => {
		const data = {
			data: [
				{
					id: 'openai/o3',
					name: 'o3',
					context_length: 200000,
					supported_parameters: ['reasoning', 'tools'],
					reasoning: {
						supported_efforts: ['high', 'medium', 'low'],
						default_effort: 'medium',
						default_enabled: true,
						mandatory: true
					}
				}
			]
		};
		const models = parseOpenRouterCatalog(data);
		expect(models[0].reasoning).toBeDefined();
		expect(models[0].reasoning?.mandatory).toBe(true);
		expect(models[0].reasoning?.default_effort).toBe('medium');
	});

	it('leaves reasoning undefined for non-reasoning models', () => {
		const data = { data: [{ id: 'openai/gpt-4o', name: 'GPT-4o', context_length: 128000 }] };
		expect(parseOpenRouterCatalog(data)[0].reasoning).toBeUndefined();
	});

	it('falls back to top_provider.context_length when context_length is missing', () => {
		const data = {
			data: [{ id: 'm', name: 'M', top_provider: { context_length: 8192 } }]
		};
		expect(parseOpenRouterCatalog(data)[0].context_length).toBe(8192);
	});

	it('carries expiration_date through and defaults to null', () => {
		const data = {
			data: [
				{ id: 'a', name: 'A', context_length: 1, expiration_date: '2026-12-01T00:00:00Z' },
				{ id: 'b', name: 'B', context_length: 1 }
			]
		};
		const models = parseOpenRouterCatalog(data);
		expect(models[0].expiration_date).toBe('2026-12-01T00:00:00Z');
		expect(models[1].expiration_date).toBeNull();
	});

	it('skips entries without an id', () => {
		const data = { data: [{ name: 'No id' }, { id: 'ok', name: 'OK', context_length: 1 }] };
		expect(parseOpenRouterCatalog(data)).toHaveLength(1);
		expect(parseOpenRouterCatalog(data)[0].id).toBe('ok');
	});

	it('returns empty array for non-object / missing data', () => {
		expect(parseOpenRouterCatalog(null)).toEqual([]);
		expect(parseOpenRouterCatalog({})).toEqual([]);
		expect(parseOpenRouterCatalog({ data: 'not-an-array' })).toEqual([]);
	});
});

describe('parseOpenRouterKeyStatus', () => {
	it('parses a nested data object', () => {
		const data = {
			data: {
				label: 'my-key',
				limit: 100,
				limit_remaining: 42,
				limit_reset: null,
				usage: 58,
				is_free_tier: false,
				usage_daily: 5,
				usage_weekly: 20,
				usage_monthly: 58
			}
		};
		const status = parseOpenRouterKeyStatus(data);
		expect(status.label).toBe('my-key');
		expect(status.limit_remaining).toBe(42);
		expect(status.is_free_tier).toBe(false);
	});

	it('defaults gracefully for an empty payload', () => {
		const status = parseOpenRouterKeyStatus({});
		expect(status.limit).toBeNull();
		expect(status.usage).toBe(0);
		expect(status.is_free_tier).toBe(false);
	});
});

describe('helpers', () => {
	const visionToolModel: OpenRouterModel = {
		id: 'openai/gpt-4o',
		name: 'GPT-4o',
		context_length: 128000,
		architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
		supported_parameters: ['tools', 'temperature'],
		pricing: { prompt: '0.00001', completion: '0.00003', request: '0' },
		expiration_date: null
	};

	it('isOpenRouterFreeModel checks the :free suffix', () => {
		expect(isOpenRouterFreeModel('meta/llama-3:free')).toBe(true);
		expect(isOpenRouterFreeModel('openai/gpt-4o')).toBe(false);
	});

	it('isOpenRouterToolCapable checks supported_parameters', () => {
		expect(isOpenRouterToolCapable(visionToolModel)).toBe(true);
		expect(isOpenRouterToolCapable(toolModel('x', 'X'))).toBe(true);
		const noTools = { ...visionToolModel, supported_parameters: ['temperature'] };
		expect(isOpenRouterToolCapable(noTools)).toBe(false);
	});

	it('isOpenRouterVisionCapable checks input_modalities', () => {
		expect(isOpenRouterVisionCapable(visionToolModel)).toBe(true);
		expect(isOpenRouterVisionCapable(toolModel('x', 'X'))).toBe(false);
	});

	it('TTL and free-tier constants are exported', () => {
		expect(OPENROUTER_CATALOG_TTL_MS).toBe(24 * 60 * 60 * 1000);
		expect(FREE_MODEL_RPM).toBe(20);
	});
});
