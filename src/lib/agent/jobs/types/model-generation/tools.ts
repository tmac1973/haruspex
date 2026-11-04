/**
 * The 3D models job's own forced tools.
 *
 * Here rather than in the coding tool file for the reason the 2D job gives:
 * a forced tool's schema is the contract between a prompt and a parser, and
 * both live in this folder.
 */

import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolResult } from '#lib/agent/tools/types.ts';
import type { ModelSpec } from '#lib/models3d/spec/types.ts';
import { uniqueId } from '#lib/models3d/spec/paths.ts';
import { modelEntryOf, objects } from '#lib/models3d/spec/derive.ts';

export const SUBMIT_MODEL_SPEC_TOOL = 'submit_model_spec';
/**
 * Guided planning's models stage: the same entries, each with the id the plan
 * already uses. Two tools for the reason the 2D job has two: a standalone run
 * has no plan to take ids from, a planned one does.
 */
export const SUBMIT_PLAN_MODEL_SPEC_TOOL = 'submit_plan_model_spec';

/** One model's fields, shared by both submit tools. */
const ENTRY_PROPERTIES = {
	title: {
		type: 'string',
		description: 'What it is, e.g. "Goblin". Two or three words.'
	},
	description: {
		type: 'string',
		description: 'What it looks like: shape, parts, colours. One or two sentences.'
	},
	height_m: {
		type: 'number',
		description: 'Overall height in metres, e.g. 1.8 for a person.'
	},
	parts: {
		type: 'array',
		items: { type: 'string' },
		description:
			'Animated models only: the pivot names at its joints, as Side_Part, ' +
			'e.g. "Pelvis", "Hip_L", "Knee_L", "Foot_L", "Shoulder_R", "Hand_R", "Neck". ' +
			'Empty for a static prop.'
	},
	clips: {
		type: 'array',
		description: 'Animated models only. Empty for a static prop.',
		items: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'e.g. "Idle", "Walk", "Attack".' },
				seconds: { type: 'number', description: 'Length, 0.2 to 10.' },
				loop: { type: 'boolean', description: 'Whether it cycles.' },
				action: {
					type: 'string',
					description: 'What happens, e.g. "swings the club down from overhead".'
				}
			},
			required: ['name', 'seconds', 'action']
		}
	}
};

registerTool({
	category: 'coding',
	schema: {
		type: 'function',
		function: {
			name: SUBMIT_MODEL_SPEC_TOOL,
			description:
				'Report the 3D models this project needs, as structured data. Call this exactly ' +
				'once, at the end.',
			parameters: {
				type: 'object',
				properties: {
					style: {
						type: 'string',
						description:
							'One line every model shares, e.g. "low-poly, flat colours, chunky ' +
							'proportions". No subject, no camera.'
					},
					entries: {
						type: 'array',
						description: 'One entry per distinct model.',
						items: {
							type: 'object',
							properties: ENTRY_PROPERTIES,
							required: ['title', 'description', 'height_m']
						}
					}
				},
				required: ['style', 'entries']
			}
		}
	},
	displayLabel: (args) =>
		`models spec: ${Array.isArray(args.entries) ? args.entries.length : '?'} model(s)`,
	// Reporting only: the runner writes the file.
	async execute() {
		return toolResult('Spec recorded.');
	}
});

/**
 * The submitted payload as a spec. Ids and folders are the runner's, never the
 * model's: a slug of each title, made unique, and the folder from the id.
 * Whatever is still wrong is left for `validateModelSpec` to name.
 */
export function specFromSubmission(args: Record<string, unknown>): ModelSpec {
	const taken = new Set<string>();
	return {
		version: 1,
		style: typeof args.style === 'string' ? args.style.trim() : '',
		entries: objects(args.entries).map((e) => {
			const id = uniqueId(typeof e.title === 'string' ? e.title.trim() : '', taken);
			taken.add(id);
			return modelEntryOf(e, id);
		})
	};
}

registerTool({
	category: 'coding',
	schema: {
		type: 'function',
		function: {
			name: SUBMIT_PLAN_MODEL_SPEC_TOOL,
			description:
				'Report the 3D models this plan needs, as structured data. Call this exactly ' +
				'once, at the end. Every id must be an id the plan already names.',
			parameters: {
				type: 'object',
				properties: {
					style: {
						type: 'string',
						description:
							'One line every model shares, e.g. "low-poly, flat colours, chunky ' +
							'proportions". No subject, no camera.'
					},
					entries: {
						type: 'array',
						description: 'One entry per distinct model. Empty when the plan needs none.',
						items: {
							type: 'object',
							properties: {
								id: {
									type: 'string',
									description:
										'The content id the plan uses for it, copied exactly: lowercase ' +
										'letters, digits and underscores, e.g. "goblin".'
								},
								...ENTRY_PROPERTIES
							},
							required: ['id', 'title', 'description', 'height_m']
						}
					}
				},
				required: ['style', 'entries']
			}
		}
	},
	displayLabel: (args) =>
		`models spec: ${Array.isArray(args.entries) ? args.entries.length : '?'} model(s)`,
	// Reporting only: the runner writes the file.
	async execute() {
		return toolResult('Spec recorded.');
	}
});
