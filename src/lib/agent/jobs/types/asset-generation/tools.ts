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
