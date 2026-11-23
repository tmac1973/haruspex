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
