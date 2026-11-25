import { afterEach, describe, expect, it } from 'vitest';
import { setCodeHelperConfig } from '#lib/stores/settings.ts';
import { DELEGATE_3D_DEFAULTS, delegate3dConfig, parseDelegate3dConfig } from './delegateConfig';

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
});
