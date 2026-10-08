/**
 * `haruspex_docs`: the model reading Haruspex's own user guide, so a question
 * about the app is answered from its docs rather than guessed at.
 *
 * Without a page it returns how this Haruspex is set up right now, then the
 * list of pages; with one, that page. Offered in every interactive Chat and
 * Shell turn, on every model, and to remote guests through their allowlist.
 * The setup status is the host's own, so only a turn with someone at this
 * keyboard (`ctx.interactive`) gets it.
 *
 * Per the CI grep guard, nothing under `tools/` may import `stores/chat`.
 */

import { GUIDE_PAGES, guideIndex, guidePage } from '#lib/guide/guide.ts';
import { guideStatus } from '#lib/guide/status.ts';
import { registerTool } from './registry';
import { toolError, toolResult } from './types';

export const HARUSPEX_DOCS_TOOL = 'haruspex_docs';

registerTool({
	category: 'guide',
	schema: {
		type: 'function',
		function: {
			name: HARUSPEX_DOCS_TOOL,
			description:
				"Read Haruspex's user guide. Without a page: how this Haruspex is set up right now (model, which features are on) and the list of pages. With a page: that page. Use it for any question about Haruspex itself.",
			parameters: {
				type: 'object',
				properties: {
					page: {
						type: 'string',
						enum: GUIDE_PAGES.map((p) => p.name),
						description: 'The page to read. Leave it out for the setup status and the page list.'
					}
				},
				required: []
			}
		}
	},
	displayLabel: (args) => (args.page ? String(args.page) : 'contents'),
	async execute(args, ctx) {
		const name = typeof args.page === 'string' ? args.page.trim() : '';
		if (name) {
			const page = guidePage(name);
			if (!page) {
				const names = GUIDE_PAGES.map((p) => p.name).join(', ');
				return toolResult(toolError(`No guide page "${name}". Pages: ${names}.`));
			}
			return toolResult(page.body);
		}
		const status = ctx.interactive
			? await guideStatus()
			: "## This Haruspex right now\nNot shown here: it is the host's own setup.";
		return toolResult(
			`${status}\n\n## Guide pages\nCall haruspex_docs with \`page\` set to one of these.\n${guideIndex()}`
		);
	}
});
