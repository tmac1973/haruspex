import { afterEach, describe, expect, it } from 'vitest';
import { setCodeHelperConfig } from '#lib/stores/settings.ts';
import {
	DELEGATE_3D_DEFAULTS,
	delegate3dConfig,
	parseDelegate3dConfig,
	sessionDelegateBackend,
	withSessionDelegate
} from './delegateConfig';

const backend = { baseUrl: 'https://openrouter.ai/api', modelId: 'anthropic/claude-x' };

describe('parseDelegate3dConfig', () => {
	it('gives the defaults for nothing stored', () => {
		expect(parseDelegate3dConfig(undefined)).toEqual(DELEGATE_3D_DEFAULTS);
		expect(parseDelegate3dConfig('junk')).toEqual(DELEGATE_3D_DEFAULTS);
		expect(DELEGATE_3D_DEFAULTS).toEqual({ backend: null, maxRounds: 80, maxCostUsd: null });
	});

	it('clamps the round cap to 5–500 and rounds it', () => {
		expect(parseDelegate3dConfig({ maxRounds: 3 }).maxRounds).toBe(5);
		expect(parseDelegate3dConfig({ maxRounds: 1000 }).maxRounds).toBe(500);
		expect(parseDelegate3dConfig({ maxRounds: 42.4 }).maxRounds).toBe(42);
		expect(parseDelegate3dConfig({ maxRounds: 'x' }).maxRounds).toBe(80);
	});

	it('keeps a positive dollar cap and makes anything else unlimited', () => {
		for (const bad of [0, -1, 'x', Number.NaN, null]) {
			expect(parseDelegate3dConfig({ maxCostUsd: bad }).maxCostUsd).toBeNull();
		}
		expect(parseDelegate3dConfig({ maxCostUsd: 2.5 }).maxCostUsd).toBe(2.5);
	});

	it('needs a server and a model for a backend', () => {
		expect(parseDelegate3dConfig({ backend: { baseUrl: 'http://box:8080' } }).backend).toBeNull();
		expect(parseDelegate3dConfig({ backend: { modelId: 'm' } }).backend).toBeNull();
		expect(
			parseDelegate3dConfig({
				backend: { ...backend, apiKeyId: 'k1', visionSupported: true, contextSize: 'x' }
			}).backend
		).toEqual({ ...backend, apiKeyId: 'k1', visionSupported: true });
	});
});

describe('delegate3dConfig', () => {
	afterEach(() => setCodeHelperConfig('3d', undefined));

	it('reads what is stored under the 3D helper', () => {
		expect(delegate3dConfig().backend).toBeNull();
		setCodeHelperConfig('3d', { backend, maxRounds: 40, maxCostUsd: 1 });
		expect(delegate3dConfig()).toEqual({ backend, maxRounds: 40, maxCostUsd: 1 });
	});

	it('takes the session’s own model, or none, but always the Settings caps', () => {
		setCodeHelperConfig('3d', { backend, maxRounds: 40, maxCostUsd: 1 });
		const own = { baseUrl: 'http://gpu-box:8080', modelId: 'qwen-big' };
		expect(delegate3dConfig({ '3d': { backend: own } })).toEqual({
			backend: own,
			maxRounds: 40,
			maxCostUsd: 1
		});
		expect(delegate3dConfig({ '3d': { backend: null } }).backend).toBeNull();
		// No entry for the 3D helper follows Settings.
		expect(delegate3dConfig({ search: {} }).backend).toEqual(backend);
		expect(delegate3dConfig(null).backend).toEqual(backend);
	});
});

describe('a session’s own delegate', () => {
	const own = { baseUrl: 'http://gpu-box:8080', modelId: 'qwen-big' };

	it('reads a model, none, or nothing (Settings)', () => {
		expect(sessionDelegateBackend({ '3d': { backend: own } })).toEqual(own);
		expect(sessionDelegateBackend({ '3d': { backend: null } })).toBeNull();
		expect(sessionDelegateBackend({ '3d': {} })).toBeUndefined();
		expect(sessionDelegateBackend(null)).toBeUndefined();
		// A model with no server is none, not Settings'.
		expect(sessionDelegateBackend({ '3d': { backend: { modelId: 'x' } } })).toBeNull();
	});

	it('sets and clears its entry, keeping other helpers’', () => {
		expect(withSessionDelegate(null, own)).toEqual({ '3d': { backend: own } });
		expect(withSessionDelegate({ search: { a: 1 } }, null)).toEqual({
			search: { a: 1 },
			'3d': { backend: null }
		});
		expect(withSessionDelegate({ search: { a: 1 }, '3d': { backend: own } }, undefined)).toEqual({
			search: { a: 1 }
		});
		// Nothing left: back to Settings for every helper.
		expect(withSessionDelegate({ '3d': { backend: own } }, undefined)).toBeNull();
	});
});
