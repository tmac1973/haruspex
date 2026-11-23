/**
 * `submit_sequence_spec`: the spec turn reports the whole spec as one forced
 * call. Like the other submit tools, the runner reads the arguments off the
 * loop's `onToolStart` and the executor only acknowledges. Category
 * `'planning'` keeps it out of every default toolset.
 */
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolResult } from '#lib/agent/tools/types.ts';
import { parseSequenceSpec, type Parsed } from '#lib/sequence/spec/parse.ts';

export const SUBMIT_SEQUENCE_SPEC_TOOL = 'submit_sequence_spec';

/** A submission's arguments as spec JSON (the version is the runner's), or null. */
export function submitted(args: unknown): Record<string, unknown> | null {
	if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
	return { ...(args as Record<string, unknown>), version: 1 };
}

/** The spec from a submission's arguments, with what is wrong with its shape. */
export function specFromSubmission(args: unknown): Parsed {
	const json = submitted(args);
	if (!json) return { spec: null, problems: ['The submission had no spec in it.'] };
	return parseSequenceSpec(json);
}

const FIT = {
	description: '"letterbox" (default), "fill", or a crop region {x, y, w, h} as fractions 0–1.'
};

/** The tool as the model sees it. */
export const SUBMIT_SEQUENCE_SPEC_SCHEMA = {
	type: 'function',
	function: {
		name: SUBMIT_SEQUENCE_SPEC_TOOL,
		description:
			'Report the video as a sequence spec. Call this exactly once, at the end, with every ' +
			'section in order, one join between each two sections, and the sound.',
		parameters: {
			type: 'object',
			properties: {
				title: { type: 'string', description: 'A short title for the video.' },
				style: {
					type: 'string',
					description:
						'One line every clip and keyframe shares: the subject, the look and the light.'
				},
				sections: {
					type: 'array',
					description:
						'The video in order: generated stretches, existing clips, and speaking sections (a person in a portrait saying lines, when there is a speaking model).',
					items: {
						type: 'object',
						properties: {
							kind: { type: 'string', enum: ['generated', 'existing', 'speaking'] },
							id: {
								type: 'string',
								description: 'A short lowercase slug, unique: "snow", "forest-2".'
							},
							prompt: {
								type: 'string',
								description:
									'generated: what happens, the subject and the camera. speaking: the setting and how the person moves.'
							},
							seconds: { type: 'number', description: 'generated: how long it lasts.' },
							start_image: {
								type: 'string',
								description: 'generated: a picture in the episode folder to start from.'
							},
							keyframe_prompt: {
								type: 'string',
								description: 'generated: what the opening still shows, when not the prompt.'
							},
							negative_prompt: { type: 'string' },
							path: {
								type: 'string',
								description: 'existing: the clip, relative to the episode folder.'
							},
							in_secs: { type: 'number', description: 'existing: where to start in it.' },
							out_secs: { type: 'number', description: 'existing: where to stop.' },
							fit: FIT,
							portrait: {
								type: 'string',
								description:
									'speaking: a picture of the person in the episode folder; one is drawn when omitted.'
							},
							portrait_prompt: {
								type: 'string',
								description: 'speaking: who the drawn portrait shows, when not the prompt.'
							},
							lines: {
								type: 'array',
								description: 'speaking: what the person says, in order.',
								items: {
									type: 'object',
									properties: {
										id: {
											type: 'string',
											description: 'A short lowercase slug, unique in the spec.'
										},
										text: { type: 'string', description: 'The words, written to be heard.' },
										voice: {
											type: 'string',
											description: 'A saved voice; the default when omitted.'
										}
									},
									required: ['id', 'text']
								}
							},
							window_join: {
								type: 'string',
								enum: ['cut', 'crossfade'],
								description: 'speaking: between its clips. Default cut.'
							}
						},
						required: ['kind', 'id']
					}
				},
				joins: {
					type: 'array',
					description: 'One between each two sections, in order.',
					items: {
						type: 'object',
						properties: {
							kind: { type: 'string', enum: ['cut', 'crossfade', 'transition'] },
							secs: { type: 'number', description: 'crossfade: up to 3 s.' },
							prompt: {
								type: 'string',
								description: 'transition: what happens as one section turns into the next.'
							}
						},
						required: ['kind']
					}
				},
				sound: {
					type: 'object',
					properties: {
						clip_sound: {
							type: 'boolean',
							description: 'Keep the sound the video model makes with each clip.'
						},
						music: {
							type: 'array',
							description: 'Songs, each under a run of sections.',
							items: {
								type: 'object',
								properties: {
									id: { type: 'string', description: 'A short lowercase slug.' },
									sections: { type: 'array', items: { type: 'string' } },
									caption: {
										type: 'string',
										description: 'What it sounds like: instruments, mood, tempo.'
									}
								},
								required: ['id', 'sections', 'caption']
							}
						},
						narration: {
							type: 'array',
							items: {
								type: 'object',
								properties: {
									section: { type: 'string' },
									at_secs: { type: 'number', description: 'Seconds into the section.' },
									text: { type: 'string' },
									voice: { type: 'string', description: 'A saved voice; omit for the default.' }
								},
								required: ['section', 'at_secs', 'text']
							}
						}
					}
				},
				reanchor_every: {
					type: 'integer',
					description: 'Re-anchor every this many clips of a section; 0 for never.'
				}
			},
			required: ['title', 'style', 'sections', 'joins', 'sound']
		}
	}
} as const;

registerTool({
	category: 'planning',
	schema: SUBMIT_SEQUENCE_SPEC_SCHEMA,
	displayLabel: () => 'Writing the sequence spec',
	execute: async () => toolResult('Spec received.')
});

export const SUBMIT_CLIP_CHECK_TOOL = 'submit_clip_check';

export interface ClipCheck {
	ok: boolean;
	problem?: string;
}

/** A check's verdict from its arguments, or null when there is none. */
export function parseClipCheck(args: unknown): ClipCheck | null {
	if (!args || typeof args !== 'object') return null;
	const o = args as Record<string, unknown>;
	if (typeof o.ok !== 'boolean') return null;
	const problem = typeof o.problem === 'string' ? o.problem.trim() : '';
	return o.ok ? { ok: true } : { ok: false, problem: problem || 'It does not match.' };
}

registerTool({
	category: 'planning',
	schema: {
		type: 'function',
		function: {
			name: SUBMIT_CLIP_CHECK_TOOL,
			description: 'Report whether the clip passes. Call this exactly once.',
			parameters: {
				type: 'object',
				properties: {
					ok: { type: 'boolean', description: 'true when both answers are yes.' },
					problem: {
						type: 'string',
						description: 'When ok is false: what is wrong, in one sentence.'
					}
				},
				required: ['ok']
			}
		}
	},
	displayLabel: () => 'Checking a clip',
	execute: async () => toolResult('Check received.')
});
