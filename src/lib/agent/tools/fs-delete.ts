/**
 * `fs_delete`: move a file this conversation made to the system trash. Only
 * a file the agent wrote here, and still as it wrote it (`_created.ts`).
 */
import { invoke } from '@tauri-apps/api/core';
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolError, toolResult } from '#lib/agent/tools/types.ts';
import { fsWorkdir, labelArg, toolInvokeError } from '#lib/agent/tools/_helpers.ts';
import { createdScope, tidyRefusal } from '#lib/agent/tools/_created.ts';
import { writeRootError } from '#lib/agent/tools/fs-write.ts';

registerTool({
	category: 'fs',
	schema: {
		type: 'function',
		function: {
			name: 'fs_delete',
			description:
				'Move a file you made in this conversation to the trash, such as a draft or a duplicate. Only files you wrote here and the user has not changed since; anything else is refused. Not for folders.',
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'The file, relative to the working directory.'
					}
				},
				required: ['path']
			}
		}
	},
	displayLabel: labelArg('path'),
	async execute(args, ctx) {
		const refusal = tidyRefusal('fs_delete', ctx);
		if (refusal) return toolResult(toolError(refusal));
		const path = typeof args.path === 'string' ? args.path.trim() : '';
		if (!path) return toolResult(toolError('fs_delete needs a "path".'));
		const rootErr = writeRootError(path, ctx);
		if (rootErr) return toolResult(toolError(rootErr));
		try {
			await invoke('fs_delete_created', {
				workdir: fsWorkdir(ctx),
				relPath: path,
				scope: createdScope(ctx)
			});
			ctx.filesWrittenThisTurn.delete(path);
			return toolResult(`Moved ${path} to the trash.`);
		} catch (e) {
			return toolResult(toolInvokeError('fs_delete', e));
		}
	}
});
