import { describe, it, expect } from 'vitest';
import { assetSpecPrompt } from './pipeline';
import { KIND_RULE, TRANSITION_RULE } from '#lib/agent/jobs/types/asset-generation/prompts.ts';

describe('assetSpecPrompt', () => {
	it('says what a texture is, and asks for sets where ground textures meet', () => {
		const p = assetSpecPrompt('plan/game', 'assets/haruspex-assets.json');
		expect(p).toContain(KIND_RULE.join('\n'));
		expect(p).toContain(TRANSITION_RULE.join('\n'));
	});
});
