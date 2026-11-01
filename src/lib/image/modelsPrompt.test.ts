import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ImageModelEntry } from './types';

const state = vi.hoisted(() => ({ models: [] as unknown[] }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: () => ({ imageModels: state.models }),
		overDefaults: true
	})
);

import { imageModelsPrompt } from './modelsPrompt';
import { buildSystemPrompt } from '#lib/agent/systemPrompt.ts';

const base = { transparency: false, seamlessTiling: false, loras: false, maxLoras: 0 };

function model(name: string, caps: object): ImageModelEntry {
	return {
		id: name,
		name,
		backend: 'llama-toolchest',
		url: 'http://asmodean:3000',
		keyId: null,
		model: name,
		options: {},
		caps: { ...base, ...caps },
		capsAt: 1,
		renamed: false
	};
}

const THREE = [
	model('Ming-Image 0.1 Design', { transparency: true }),
	model('klein', { edit: true, maxEditImages: 4, upscale: true }),
	model('FLUX.3 Image Klein', { edit: true, maxEditImages: 10 })
];

beforeEach(() => {
	state.models = [];
});

describe('imageModelsPrompt', () => {
	it('is empty with one model: there is nothing to choose', () => {
		state.models = THREE.slice(0, 1);
		expect(imageModelsPrompt()).toBe('');
	});

	it('lists several, in the order used', () => {
		state.models = THREE;
		expect(imageModelsPrompt()).toBe(`

IMAGE MODELS, in the order the image tools use them:
- Ming-Image 0.1 Design: draws, transparent backgrounds.
- klein: draws, edits up to 4 pictures, upscales.
- FLUX.3 Image Klein: draws, edits up to 10 pictures.
- The tools pick the first model that can do the job. Pass \`model\` only when the user names one.`);
	});

	it('goes into a Chat prompt asking for it, and not a lean one', () => {
		state.models = THREE;
		const text = (opts: object) => buildSystemPrompt(null, opts).content as string;
		expect(text({ imageModels: true })).toContain('IMAGE MODELS');
		expect(text({ imageModels: true, lean: true })).not.toContain('IMAGE MODELS');
		expect(text({})).not.toContain('IMAGE MODELS');
	});
});
