import { describe, it, expect } from 'vitest';
import { defaultVideoName, videoModelsFromFields } from './fields';
import { videoCaps } from '#lib/testing/videoModels.ts';

const old = {
	videoGenBackendKind: 'llama-toolchest' as const,
	videoGenToolchestBaseUrl: ' http://box:3000 ',
	videoGenToolchestApiKeyId: 'k1',
	videoGenToolchestModelId: 'ltx-2.3'
};

describe('videoModelsFromFields', () => {
	it('is no entry for None or nothing stored', () => {
		expect(videoModelsFromFields({ videoGenBackendKind: 'none' })).toEqual([]);
		expect(videoModelsFromFields({})).toEqual([]);
	});

	it('makes the toolchest instance one entry', () => {
		expect(videoModelsFromFields(old)).toEqual([
			{
				id: 'legacy',
				name: 'ltx-2.3',
				backend: 'llama-toolchest',
				url: 'http://box:3000',
				keyId: 'k1',
				model: 'ltx-2.3',
				options: {},
				caps: null,
				capsAt: null,
				renamed: false
			}
		]);
	});

	it("keeps a name the user set, and the caps while the config doesn't change", () => {
		const [first] = videoModelsFromFields(old);
		const previous = [{ ...first, name: 'Mine', renamed: true, caps: videoCaps(), capsAt: 5 }];
		expect(videoModelsFromFields(old, previous)[0]).toMatchObject({
			name: 'Mine',
			renamed: true,
			capsAt: 5
		});
		const moved = videoModelsFromFields({ ...old, videoGenToolchestModelId: 'wan' }, previous);
		expect(moved[0]).toMatchObject({ name: 'Mine', model: 'wan', caps: null, capsAt: null });
	});
});

describe('defaultVideoName', () => {
	it('is the instance id, a ComfyUI file name without folder or extension, or a label', () => {
		expect(defaultVideoName({ backend: 'llama-toolchest', model: 'ti2v' })).toBe('ti2v');
		expect(
			defaultVideoName({ backend: 'comfyui', model: 'wan/wan2.2_ti2v_5B_fp16.safetensors' })
		).toBe('wan2.2_ti2v_5B_fp16');
		expect(defaultVideoName({ backend: 'comfyui', model: ' ' })).toBe('Video model');
	});
});
