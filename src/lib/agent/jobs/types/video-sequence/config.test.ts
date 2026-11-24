import { describe, it, expect, vi } from 'vitest';

vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: {
			videoModels: [
				{
					id: 'entry-ltx',
					name: 'LTX',
					backend: 'llama-toolchest',
					url: 'http://box:3000',
					keyId: null,
					model: 'ltx-2.3',
					options: {},
					caps: null,
					capsAt: null,
					renamed: false
				}
			]
		},
		overDefaults: true
	})
);

import {
	configDefaults,
	configProblem,
	configToJson,
	inEpisode,
	parseConfig,
	specPathFor
} from './config';

describe('the Video sequence config', () => {
	it('round-trips through its JSON', () => {
		const c = {
			...configDefaults(),
			episode_dir: 'ep14/',
			brief: 'a fox in snow',
			run_mode: 'unattended' as const,
			video_model_id: 'entry-ltx',
			speaking_model_id: 'none',
			image_keyframes: false,
			reanchor_every: 4,
			editor: 'kdenlive' as const
		};
		expect(parseConfig(configToJson(c))).toEqual({ ...c, episode_dir: 'ep14' });
	});

	it('reads a config saved before the video model list', () => {
		expect(
			parseConfig(JSON.stringify({ video_instance_id: 'ltx-2.3', speaking_instance_id: 's2v' }))
		).toMatchObject({ video_model_id: 'entry-ltx', speaking_model_id: 's2v' });
		expect(parseConfig('{}')).toMatchObject({ video_model_id: '', speaking_model_id: '' });
		const json = JSON.parse(configToJson(parseConfig('{"video_instance_id":"ltx-2.3"}')));
		expect(json).not.toHaveProperty('video_instance_id');
		expect(json.video_model_id).toBe('entry-ltx');
	});

	it('reads a broken or odd config safely: attended, defaults in range', () => {
		expect(parseConfig('{nope')).toEqual(configDefaults());
		expect(
			parseConfig(JSON.stringify({ run_mode: 'UNATTENDED', reanchor_every: 99 }))
		).toMatchObject({ run_mode: 'attended', reanchor_every: 6 });
	});

	it('keeps the episode folder inside the working folder', () => {
		const c = { ...configDefaults(), brief: 'x' };
		expect(configProblem(c, '')).toMatch(/needs a working folder/);
		expect(configProblem({ ...c, episode_dir: '../other' }, '/v')).toMatch(/inside the working/);
		expect(configProblem({ ...c, episode_dir: '/abs' }, '/v')).toMatch(/inside the working/);
		expect(configProblem({ ...c, brief: ' ' }, '/v')).toBe('Describe the video in the brief.');
		expect(configProblem({ ...c, reanchor_every: 2.5 }, '/v')).toMatch(/whole number/);
		expect(configProblem({ ...c, episode_dir: './ep1' }, '/v')).toBeNull();
	});

	it('puts the spec in the episode folder', () => {
		expect(specPathFor({ episode_dir: '' })).toBe('sequence.json');
		expect(specPathFor({ episode_dir: 'ep14' })).toBe('ep14/sequence.json');
		expect(inEpisode({ episode_dir: 'ep14' }, 'keyframes/a.png')).toBe('ep14/keyframes/a.png');
	});
});
