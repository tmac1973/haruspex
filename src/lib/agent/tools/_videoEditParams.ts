/**
 * `video_edit`'s parameters other than the episode and project: the ops on one
 * clip and what each takes. Kept apart from `video.ts` so the ops can grow.
 */
import { EDIT_OPS, FIT_PARAMS, FRAME_PARAMS, GAIN_RANGE_PARAMS } from '#lib/video/args.ts';

export const EDIT_PROPERTIES = {
	op: {
		type: 'string',
		enum: EDIT_OPS
	},
	index: {
		type: 'integer',
		description: 'The clip, from 1. remove_silences: omit for every clip.'
	},
	in_secs: { type: 'number', description: 'trim: start this far into the clip.' },
	out_secs: { type: 'number', description: 'trim: stop this far into the clip.' },
	...FRAME_PARAMS,
	...FIT_PARAMS,
	...GAIN_RANGE_PARAMS,
	to: { type: 'integer', description: 'move: its new position, from 1.' },
	secs: { type: 'number', description: 'hold: how long to hold the frame, up to 60 s.' },
	end: {
		type: 'string',
		enum: ['first', 'last'],
		description:
			'hold: its first frame before it, or its last after it (the default). Ignored with at.'
	},
	at: {
		type: 'string',
		description:
			"hold: instead, the frame at this time in the clip's own time; the clip splits around the hold."
	},
	ranges: {
		type: 'array',
		description:
			"remove_ranges: stretches to cut, in the clip's own time (as video_transcribe and video_silences give it), e.g. a retake.",
		items: {
			type: 'object',
			properties: { from: { type: 'string' }, to: { type: 'string' } }
		}
	},
	min_secs: {
		type: 'number',
		description: 'remove_silences: shortest silence to cut. Default 1.5.'
	},
	pad_secs: {
		type: 'number',
		description: 'remove_silences: quiet kept at each side of a cut. Default 0.25.'
	}
};
