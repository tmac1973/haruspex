/**
 * The asset job's own forced tools.
 *
 * Defined here rather than in the coding tool file because they belong to this
 * job type and nothing else calls them — and because a forced tool's schema is
 * the contract between a prompt and a parser, which is easier to keep honest
 * when both live in the same folder.
 */

import { registerTool } from '$lib/agent/tools/registry';
import { toolResult } from '$lib/agent/tools/types';

export const SUBMIT_ASSET_JUDGEMENT_TOOL = 'submit_asset_judgement';

/** What the vision judge reports about one generated asset. */
export interface AssetJudgement {
	ok: boolean;
	reason: string;
}

registerTool({
	category: 'coding',
	schema: {
		type: 'function',
		function: {
			name: SUBMIT_ASSET_JUDGEMENT_TOOL,
			description:
				'Report whether the generated image is usable. Call this exactly once, ' +
				'at the end, whatever you decide.',
			parameters: {
				type: 'object',
				properties: {
					ok: {
						type: 'boolean',
						description:
							'True if the image clearly shows the requested subject AND matches the ' +
							'style of the reference sheet. False otherwise.'
					},
					reason: {
						type: 'string',
						description:
							'One sentence saying what you saw. Required whether ok is true or false — ' +
							'a rejection nobody can read is a rejection nobody can act on.'
					}
				},
				required: ['ok', 'reason']
			}
		}
	},
	displayLabel: (args) => `judgement: ${args.ok === true ? 'ok' : 'rejected'}`,
	// Reporting only. The judge never touches the project.
	async execute() {
		return toolResult('Judgement recorded.');
	}
});

/** Read one judgement out of a tool call, defensively. */
export function parseJudgement(args: Record<string, unknown> | undefined): AssetJudgement | null {
	if (!args || typeof args.ok !== 'boolean') return null;
	const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
	return { ok: args.ok, reason: reason || (args.ok ? 'Accepted.' : 'Rejected without a reason.') };
}

export const SUBMIT_PLAN_ASSET_SPEC_TOOL = 'submit_plan_asset_spec';

/**
 * One asset as emitted by guided planning's asset stage.
 *
 * Unlike the standalone derivation's entries, these carry an explicit `id`.
 * The difference is the whole point of having two tools: a standalone run has
 * no plan to take ids from, so the runner slugifies a title and owns the
 * result. A chained run does — the plan already names its content ids, and the
 * coding run will reference exactly those. An id invented here would leave the
 * generated file and the code that loads it disagreeing, which is the failure
 * this stage exists to prevent.
 *
 * The runner validates the id against the shape rule rather than slugifying
 * it, so a model that submits `Iron Sword` is rejected rather than silently
 * given `iron_sword` while the plan still says something else.
 */
export interface PlanAssetEntryArg {
	id: string;
	kind?: string;
	prompt?: string;
	size?: number;
	seamless?: boolean;
	negativePrompt?: string;
	notes?: string;
}

registerTool({
	category: 'coding',
	schema: {
		type: 'function',
		function: {
			name: SUBMIT_PLAN_ASSET_SPEC_TOOL,
			description:
				'Report the images this plan needs, as structured data. Call this exactly ' +
				'once, at the end. Every id must be an id the plan already names.',
			parameters: {
				type: 'object',
				properties: {
					style: {
						type: 'object',
						description: 'What every asset has in common. This is what makes the set cohere.',
						properties: {
							prompt: {
								type: 'string',
								description:
									'ONE SHORT LINE, at most about 25 words: medium, palette and line ' +
									'weight. The image model reads only the first 77 tokens of a prompt, ' +
									'so a long style pushes the subject out of the window. Never a ' +
									'subject, a camera angle or a genre.'
							},
							negativePrompt: {
								type: 'string',
								description: 'What the whole set avoids. Usually a short list.'
							}
						},
						required: ['prompt']
					},
					entries: {
						type: 'array',
						description: 'Every image the plan needs, and nothing it does not.',
						items: {
							type: 'object',
							properties: {
								id: {
									type: 'string',
									description:
										'The content id the plan uses for this thing, exactly. Lowercase ' +
										'letters, digits and underscores, starting with a letter.'
								},
								kind: {
									type: 'string',
									enum: ['sprite', 'texture', 'icon'],
									description:
										'sprite for an object or character needing a transparent background, ' +
										'texture for ground or walls that must tile, icon for a UI symbol.'
								},
								prompt: {
									type: 'string',
									description: 'The SUBJECT only. The shared style is added automatically.'
								},
								size: { type: 'number', description: 'Pixel size, if this one differs.' },
								seamless: { type: 'boolean', description: 'Must tile. Implied for textures.' },
								negativePrompt: {
									type: 'string',
									description: 'Anything to avoid for this asset in particular.'
								},
								notes: { type: 'string', description: 'A note for whoever reads the file.' }
							},
							required: ['id', 'kind', 'prompt']
						}
					}
				},
				required: ['style', 'entries']
			}
		}
	},
	displayLabel: (args) => {
		const n = Array.isArray(args.entries) ? args.entries.length : 0;
		return `plan asset spec: ${n} asset${n === 1 ? '' : 's'}`;
	},
	async execute() {
		return toolResult('Asset spec recorded.');
	}
});
