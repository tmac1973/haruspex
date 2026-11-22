import { describe, it, expect } from 'vitest';
import asmodean from './fixtures/models-asmodean.json';
import compute2 from './fixtures/models-compute2.json';
import { familyOfRecipe, parseGenerationModels } from './models';

describe('parseGenerationModels', () => {
	it('keeps one kind of generation instance and drops the chat models', () => {
		const images = parseGenerationModels(asmodean, 'image');
		expect(images.map((i) => i.id)).toEqual(['qwen-turbo-local']);
		expect(images[0]).toMatchObject({
			recipe: 'qwen-image-21-turbo',
			state: 'running',
			api: ['images.sync', 'images.jobs'],
			commercialUse: false
		});
		expect(parseGenerationModels(asmodean, 'music').map((i) => [i.id, i.state])).toEqual([
			['ace-xl', 'stopped']
		]);
	});

	it('reads a Ming instance as transparent-capable and commercially usable', () => {
		const [ming] = parseGenerationModels(compute2, 'image');
		expect(ming).toMatchObject({
			id: 'ming-gpu1',
			capabilities: ['alpha'],
			commercialUse: true,
			licence: 'MIT — commercial use allowed.'
		});
		expect(familyOfRecipe(ming.recipe)).toBe('ming');
	});

	it('gives a build without meta.api the routes it had', () => {
		const old = {
			data: [
				{ id: 'img', owned_by: 'llama-toolchest', meta: { kind: 'image', state: 'running' } },
				{ id: 'song', owned_by: 'llama-toolchest', meta: { kind: 'music', state: 'running' } }
			]
		};
		expect(parseGenerationModels(old, 'image')[0].api).toEqual(['images.sync']);
		expect(parseGenerationModels(old, 'music')[0].api).toEqual(['music.jobs']);
	});

	it('ignores servers that are not toolchest and answers that are not lists', () => {
		const other = { data: [{ id: 'x', owned_by: 'someone', meta: { kind: 'image' } }] };
		expect(parseGenerationModels(other, 'image')).toEqual([]);
		expect(parseGenerationModels(null, 'image')).toEqual([]);
		expect(parseGenerationModels({ data: 'nope' }, 'image')).toEqual([]);
	});

	it('leaves an unknown recipe without a licence verdict', () => {
		const flux = {
			data: [
				{
					id: 'flux',
					owned_by: 'llama-toolchest',
					meta: { kind: 'image', recipe: 'flux2-klein-4b', capabilities: ['edit'] }
				}
			]
		};
		expect(parseGenerationModels(flux, 'image')[0]).toMatchObject({
			licence: 'unknown',
			commercialUse: null
		});
		expect(familyOfRecipe('flux2-klein-4b')).toBeNull();
	});

	it('reads end_image and the audio input from a video instance, and keeps older metas', () => {
		const video = (id: string, capabilities: string[] | undefined) => ({
			id,
			owned_by: 'llama-toolchest',
			meta: {
				kind: 'video',
				recipe: 'wan22-i2v',
				...(capabilities ? { capabilities } : {}),
				video: { default_fps: 16, default_frames: 33, default_size: '832x480' }
			}
		});
		const [lightning, s2v, old] = parseGenerationModels(
			{
				data: [
					video('lightning1116', ['start_image', 'end_image']),
					video('s2v', ['start_image', 'audio']),
					video('ti2v', undefined)
				]
			},
			'video'
		);
		expect(lightning.capabilities).toContain('end_image');
		expect(s2v.capabilities).not.toContain('end_image');
		expect(old.capabilities).toEqual([]);
		expect(old.video?.defaultFps).toBe(16);
	});
});
