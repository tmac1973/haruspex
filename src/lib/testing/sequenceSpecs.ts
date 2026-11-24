/** Specs and instance limits the sequence-spec tests share. */
import type { VideoLimits } from '#lib/toolchest/models.ts';
import type { SequenceSpec } from '#lib/sequence/spec/types.ts';

/** LTX-2.3 as llama-toolchest lists it: 121 frames at 24 fps. */
export const LTX: VideoLimits = {
	defaultFps: 24,
	defaultFrames: 121,
	defaultSize: '1280x704',
	maxFrames: 121,
	maxSize: '1280x704',
	maxPixelFrames: null,
	fixedFps: null
};

/** That LTX-2.3 as a clip plan takes it: its limits and its frame counts, 8n + 1. */
export const LTX_MODEL = { limits: LTX, frameStep: 8 };

export const LTX_CAPS = ['text', 'start_image', 'end_image'];

/** A fox in snow for a minute, then a summer forest, joined by a transition. */
export function foxSpec(): SequenceSpec {
	return {
		version: 1,
		title: 'Fox seasons',
		style: 'a red fox, natural light, documentary look',
		sections: [
			{ kind: 'generated', id: 'snow', prompt: 'a fox walking through deep snow', seconds: 60 },
			{
				kind: 'generated',
				id: 'forest',
				prompt: 'a fox in a sunny summer forest',
				seconds: 60
			}
		],
		joins: [{ kind: 'transition', prompt: 'the snow melts into green forest' }],
		sound: {
			clip_sound: true,
			music: [{ id: 'piano', sections: ['snow', 'forest'], caption: 'gentle solo piano' }],
			narration: []
		},
		reanchor_every: 6
	};
}

/** A speaking instance whose longest clip is 10 s: 160 frames at 16 fps. */
export const S2V_10S: VideoLimits = {
	defaultFps: 16,
	defaultFrames: 33,
	defaultSize: '832x480',
	maxFrames: 160,
	maxSize: '1280x720',
	maxPixelFrames: null,
	fixedFps: 16
};

export const S2V_CAPS = ['start_image', 'audio'];

/** The fox spec with a presenter between the snow and the forest. */
export function presenterSpec(): SequenceSpec {
	const spec = foxSpec();
	spec.sections.splice(1, 0, {
		kind: 'speaking',
		id: 'host',
		prompt: 'a presenter in a winter coat, talking to the camera',
		lines: [
			{ id: 'l1', text: 'Foxes hunt by sound.' },
			{ id: 'l2', text: 'They hear a mouse under a metre of snow.', voice: 'Tim' },
			{ id: 'l3', text: 'Then they jump.' }
		]
	});
	spec.joins.splice(1, 0, { kind: 'cut' });
	return spec;
}
