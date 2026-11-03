/**
 * The 3D models job's own forced tools.
 *
 * Here rather than in the coding tool file for the reason the 2D job gives:
 * a forced tool's schema is the contract between a prompt and a parser, and
 * both live in this folder.
 */

import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolResult } from '#lib/agent/tools/types.ts';
import { LOOPING_CLIP, type ModelClip, type ModelSpec } from '#lib/models3d/spec/types.ts';
import { modelDir, uniqueId } from '#lib/models3d/spec/paths.ts';

export const SUBMIT_MODEL_SPEC_TOOL = 'submit_model_spec';

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
							properties: {
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
										'e.g. "Hip_L", "Knee_L", "Shoulder_R", "Neck". Empty for a static prop.'
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
							},
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

function str(v: unknown): string {
	return typeof v === 'string' ? v.trim() : '';
}

/** NaN when absent, so validation reports it rather than a quiet zero. */
function num(v: unknown): number {
	if (typeof v === 'number') return v;
	const n = typeof v === 'string' ? Number(v) : NaN;
	return Number.isFinite(n) ? n : NaN;
}

function objects(v: unknown): Record<string, unknown>[] {
	return Array.isArray(v)
		? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
		: [];
}

function clip(c: Record<string, unknown>): ModelClip {
	const name = str(c.name);
	return {
		name,
		seconds: num(c.seconds),
		loop: typeof c.loop === 'boolean' ? c.loop : LOOPING_CLIP.test(name),
		action: str(c.action)
	};
}

/**
 * The submitted payload as a spec. Ids and folders are the runner's, never the
 * model's: a slug of each title, made unique, and the folder from the id.
 * Whatever is still wrong is left for `validateModelSpec` to name.
 */
export function specFromSubmission(args: Record<string, unknown>): ModelSpec {
	const taken = new Set<string>();
	return {
		version: 1,
		style: str(args.style),
		entries: objects(args.entries).map((e) => {
			const title = str(e.title);
			const id = uniqueId(title, taken);
			taken.add(id);
			return {
				id,
				title,
				description: str(e.description),
				height_m: num(e.height_m),
				parts: Array.isArray(e.parts) ? e.parts.map(str).filter((p) => p.length > 0) : [],
				clips: objects(e.clips).map(clip),
				dir: modelDir(id)
			};
		})
	};
}
