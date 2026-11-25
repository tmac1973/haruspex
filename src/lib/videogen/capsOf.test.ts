import { describe, it, expect } from 'vitest';
import { capsFromInstance } from './capsOf';
import type { ToolchestInstance } from '#lib/toolchest/models.ts';

const limits = {
	defaultFps: 24,
	defaultFrames: 121,
	defaultSize: '1280x704',
	maxFrames: 121,
	maxSize: null,
	maxPixelFrames: null,
	fixedFps: null
};

function instance(over: Partial<ToolchestInstance>): ToolchestInstance {
	return {
		id: 'x',
		modelSet: '',
		recipe: '',
		capabilities: [],
		state: 'running',
		api: ['video.jobs'],
		tasks: [],
		maxEditImages: null,
		scale: null,
		video: limits,
		vupscale: null,
		licence: 'Apache 2.0',
		commercialUse: true,
		...over
	};
}

describe('capsFromInstance', () => {
	it('reads Wan capabilities', () => {
		expect(
			capsFromInstance(instance({ recipe: 'wan22-ti2v-5b', capabilities: ['text', 'start_image'] }))
		).toEqual({
			text: true,
			startImage: true,
			endImage: false,
			speech: false,
			needsSpeech: false,
			sound: false,
			limits,
			frameStep: 4,
			licence: 'Apache 2.0',
			commercialUse: true
		});
	});

	it('gives LTX sound and eight-frame steps, and S2V speech it needs', () => {
		expect(capsFromInstance(instance({ id: 'ltx-2.3', capabilities: ['text'] }))).toMatchObject({
			sound: true,
			frameStep: 8
		});
		expect(
			capsFromInstance(instance({ id: 's2v', capabilities: ['start_image', 'audio'] }))
		).toMatchObject({ speech: true, needsSpeech: true, text: false });
	});

	it('is null for an instance that makes no video', () => {
		expect(capsFromInstance(instance({ video: null }))).toBeNull();
	});
});
