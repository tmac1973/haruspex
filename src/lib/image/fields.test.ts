import { describe, it, expect } from 'vitest';
import { defaultImageName, imageModelsFromFields } from './fields';

const toolchest = {
	imageBackendKind: 'llama-toolchest' as const,
	imageToolchestBaseUrl: 'http://box:3000/',
	imageToolchestApiKeyId: 'k1',
	imageToolchestModelId: 'klein'
};
const caps = { transparency: false, seamlessTiling: false, loras: false, maxLoras: 0, edit: true };

describe('imageModelsFromFields', () => {
	it('is none for None and one entry for a chosen backend', () => {
		expect(imageModelsFromFields({ imageBackendKind: 'none' })).toEqual([]);
		expect(imageModelsFromFields({})).toEqual([]);
		expect(imageModelsFromFields(toolchest)).toEqual([
			{
				id: 'legacy',
				name: 'klein',
				backend: 'llama-toolchest',
				url: 'http://box:3000/',
				keyId: 'k1',
				model: 'klein',
				options: {},
				caps: null,
				capsAt: null,
				renamed: false
			}
		]);
	});

	it('keeps a name the user gave and what a probe saw while nothing that matters changed', () => {
		const [was] = imageModelsFromFields(toolchest);
		const kept = { ...was, name: 'Editor', renamed: true, caps, capsAt: 5 };
		expect(imageModelsFromFields(toolchest, [kept])[0]).toMatchObject({
			name: 'Editor',
			caps,
			capsAt: 5
		});
		const moved = imageModelsFromFields({ ...toolchest, imageToolchestModelId: 'ming' }, [kept]);
		expect(moved[0]).toMatchObject({ name: 'Editor', model: 'ming', caps: null, capsAt: null });
	});

	it('starts afresh when the backend changes', () => {
		const [was] = imageModelsFromFields(toolchest);
		const kept = { ...was, name: 'Editor', renamed: true, caps };
		const [now] = imageModelsFromFields({ imageBackendKind: 'local', imageLocalModelId: 'ming' }, [
			kept
		]);
		expect(now).toMatchObject({ backend: 'local', name: 'ming', renamed: false, caps: null });
	});
});

describe('defaultImageName', () => {
	it('is the model, a checkpoint’s file name, or the backend when no model is chosen', () => {
		expect(defaultImageName({ backend: 'llama-toolchest', model: 'klein' })).toBe('klein');
		expect(defaultImageName({ backend: 'comfyui', model: 'sub/sd_xl.safetensors' })).toBe('sd_xl');
		expect(defaultImageName({ backend: 'lemonade', model: ' ' })).toBe('Lemonade');
	});
});
