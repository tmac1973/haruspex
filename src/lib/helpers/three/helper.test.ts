import { afterEach, describe, expect, it } from 'vitest';
import { helperPrompt, helpers } from '#lib/helpers/registry.ts';
import { setCodeHelperConfig } from '#lib/stores/settings.ts';
import './helper';

const three = () => helpers().find((h) => h.id === '3d')!;

describe('the 3D helper’s TOOLS line', () => {
	afterEach(() => setCodeHelperConfig('3d', undefined));

	it('names delegate_3d and its model only while a delegate is set', () => {
		expect(helperPrompt(three())).toBe('');
		setCodeHelperConfig('3d', {
			backend: { baseUrl: 'https://openrouter.ai/api', modelId: 'vendor/big' }
		});
		expect(helperPrompt(three())).toBe(
			'- delegate_3d — hand a new 3D asset, or a change to one it made, to vendor/big · OpenRouter; describe it fully. Use check_3d yourself to look at or measure an asset, not to build one.'
		);
	});

	it('owns check_3d and delegate_3d, and has settings', () => {
		expect(three().tools).toEqual(['check_3d', 'delegate_3d']);
		expect(three().settings?.parse(undefined)).toEqual({
			backend: null,
			maxRounds: 80,
			maxCostUsd: null
		});
	});
});
