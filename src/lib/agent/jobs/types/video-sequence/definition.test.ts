import { describe, it, expect, vi, beforeEach } from 'vitest';

const env = vi.hoisted(() => ({ backend: 'llama-toolchest', tools: true }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: () => ({
			videoModels:
				env.backend === 'none'
					? []
					: [
							{
								id: 'v',
								name: 'v',
								backend: 'llama-toolchest',
								url: '',
								keyId: null,
								model: 'v',
								options: {},
								caps: null,
								capsAt: null,
								renamed: false
							}
						]
		}),
		overDefaults: true
	})
);
vi.mock('#lib/video/binaries.ts', () => ({
	refreshVideoBinaries: async () => null,
	videoToolsOn: () => env.tools,
	videoOverrides: () => ({})
}));

import { SEQUENCE_STAGES, sequenceAvailable, videoSequenceJobType } from './definition';
import { REPORT, SPEC } from './pipeline';
import { foxSpec } from '#lib/testing/sequenceSpecs.ts';

beforeEach(() => {
	env.backend = 'llama-toolchest';
	env.tools = true;
});

describe('the Video sequence job type', () => {
	it('is available only with the video tools on and video generation set up', async () => {
		expect(await sequenceAvailable()).toBe(true);
		env.tools = false;
		expect(await sequenceAvailable()).toBe(false);
		env.tools = true;
		env.backend = 'none';
		expect(await sequenceAvailable()).toBe(false);
	});

	it('lists its stages where the pipeline numbers them', () => {
		expect(SEQUENCE_STAGES[SPEC].title).toBe('Spec');
		expect(SEQUENCE_STAGES[REPORT].title).toBe('Report');
		expect(videoSequenceJobType.planSteps({} as never)).toHaveLength(10);
	});

	it('wants a brief, and takes a spec a chat wrote', () => {
		const config = videoSequenceJobType.configDefaults();
		const input = { name: 'Fox', workingDir: '/v', steps: [], config };
		expect(videoSequenceJobType.missingRequired!(input)).toEqual(['Brief']);
		expect(videoSequenceJobType.validate!(input)).toBe('Describe the video in the brief.');
		const spec = videoSequenceJobType.propose!.spec!;
		expect(spec.path({ episode_dir: 'ep1' })).toBe('ep1/sequence.json');
		expect(spec.problems(JSON.stringify(foxSpec()))).toEqual([]);
		expect(spec.problems('{"title": "x"}')).toContain(
			'sections: the spec needs at least one section'
		);
	});

	it('offers Resume on a run that failed or was stopped', () => {
		const resume = videoSequenceJobType.canResume!;
		expect(resume({ status: 'failed' }, {} as never)).toBe(true);
		expect(resume({ status: 'cancelled' }, {} as never)).toBe(true);
		expect(resume({ status: 'succeeded' }, {} as never)).toBe(false);
	});
});
