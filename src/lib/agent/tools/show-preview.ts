/**
 * `show_preview`: the Web preview helper's tool (Settings → Code → Helpers).
 * Opens an `.html` file from the Code session's folder in that session's
 * preview window and returns its address, which the Playwright server's
 * `browser_navigate` can open without asking. Rust's preview server checks
 * the path (`src-tauri/src/preview/`); this makes it relative and refuses
 * what can't have a window here.
 */
import { ctxCwd, labelArg } from '#lib/agent/tools/_helpers.ts';
import { registerTool } from '#lib/agent/tools/registry.ts';
import {
	toolError,
	toolResult,
	type ToolContext,
	type ToolExecOutput
} from '#lib/agent/tools/types.ts';
import { relativeToRoot } from '#lib/code/paths.ts';
import { openPreview } from '#lib/preview/open.ts';
import { errMessage } from '#lib/utils/error.ts';

export const SHOW_PREVIEW_DESCRIPTION =
	"Open an .html file from the project in a preview window the user sees. It reloads when the page's files change, so call it once per page. Returns the page's address for browser_navigate.";

export async function executeShowPreview(
	args: Record<string, unknown>,
	ctx: Pick<ToolContext, 'codeSessionId' | 'wslDistro' | 'shellMode' | 'shellCwd' | 'workingDir'>
): Promise<ToolExecOutput> {
	const root = ctxCwd(ctx);
	if (!ctx.codeSessionId || !root)
		return toolResult(toolError('Previews are for Code sessions only.'));
	if (ctx.wslDistro) return toolResult(toolError("Previews don't work for WSL folders yet."));
	const given = typeof args.path === 'string' ? args.path.trim() : '';
	if (!given) return toolResult(toolError('Give the path of an .html file.'));
	const rel = relativeToRoot(root, given);
	if (rel === null || rel === '')
		return toolResult(toolError(`Not inside the session folder: ${given}`));
	try {
		const url = await openPreview(ctx.codeSessionId, root, rel);
		return toolResult(`Opened ${rel} in the preview window on this computer. Address: ${url}`);
	} catch (e) {
		return toolResult(toolError(errMessage(e)));
	}
}

registerTool({
	category: 'fs',
	schema: {
		type: 'function',
		function: {
			name: 'show_preview',
			description: SHOW_PREVIEW_DESCRIPTION,
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'The .html file, relative to the project.'
					}
				},
				required: ['path']
			}
		}
	},
	displayLabel: labelArg('path'),
	execute: executeShowPreview
});
