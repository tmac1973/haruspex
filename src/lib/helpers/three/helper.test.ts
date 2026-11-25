import { afterEach, describe, expect, it } from 'vitest';
import { helperPrompt, helperPrompts, helpers } from '#lib/helpers/registry.ts';
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
			'- delegate_3d — hand a new 3D asset, or a change to one it made, to vendor/big · OpenRouter; describe it fully. It runs in the background and its report comes to you in a new turn, so do not pass wait just to see or tell the user the result; pass it only when a step in this turn uses the finished .glb, such as placing it in a scene. Use check_3d yourself to look at or measure an asset, not to build one.'
		);
	});

	it('names the session’s own model, or none, over the Settings one', () => {
		setCodeHelperConfig('3d', {
			backend: { baseUrl: 'https://openrouter.ai/api', modelId: 'vendor/big' }
		});
		const own = {
			'3d': { backend: { baseUrl: 'https://openrouter.ai/api', modelId: 'other/one' } }
		};
		expect(helperPrompts([three()], false, own)[0].prompt).toMatch(/to other\/one · OpenRouter;/);
		expect(helperPrompt(three(), { '3d': { backend: null } })).toBe('');
	});

	it('is left out of a read-only turn, which is offered neither tool', () => {
		setCodeHelperConfig('3d', {
			backend: { baseUrl: 'https://openrouter.ai/api', modelId: 'vendor/big' }
		});
		expect(helperPrompts([three()], true)).toEqual([{ id: '3d', prompt: undefined }]);
		expect(helperPrompts([three()], false)[0].prompt).toMatch(/^- delegate_3d — /);
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
