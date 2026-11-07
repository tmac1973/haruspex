/**
 * `fs_move`: move or rename a file this conversation made, inside the
 * working folder. The same rule as `fs_delete` (`_created.ts`), and it won't
 * replace a file that isn't the agent's too.
 */
import { invoke } from '@tauri-apps/api/core';
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolError, toolResult } from '#lib/agent/tools/types.ts';
import { fsWorkdir, toolInvokeError } from '#lib/agent/tools/_helpers.ts';
import { createdScope, tidyRefusal } from '#lib/agent/tools/_created.ts';
import { writeRootError } from '#lib/agent/tools/fs-write.ts';

const pathArg = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

registerTool({
	category: 'fs',
	schema: {
		type: 'function',
		function: {
			name: 'fs_move',
			description:
				'Move or rename a file you made in this conversation, inside the working directory. Only files you wrote here and the user has not changed since; it will not replace a file that is not yours. Not for folders.',
			parameters: {
				type: 'object',
				properties: {
					from: {
						type: 'string',
						description: 'The file now, relative to the working directory.'
					},
					to: {
						type: 'string',
						description:
							'Its new path, relative to the working directory. Missing folders are made.'
					}
				},
				required: ['from', 'to']
			}
		}
	},
	displayLabel: (args) => `${pathArg(args.from)} → ${pathArg(args.to)}`,
	async execute(args, ctx) {
		const refusal = tidyRefusal('fs_move', ctx);
		if (refusal) return toolResult(toolError(refusal));
		const from = pathArg(args.from);
		const to = pathArg(args.to);
		if (!from || !to) return toolResult(toolError('fs_move needs "from" and "to".'));
		const rootErr = writeRootError(from, ctx) ?? writeRootError(to, ctx);
		if (rootErr) return toolResult(toolError(rootErr));
		try {
			await invoke('fs_move_created', {
				workdir: fsWorkdir(ctx),
				from,
				to,
				scope: createdScope(ctx)
			});
			// A write this turn to the new path is a rewrite of the same file.
			if (ctx.filesWrittenThisTurn.delete(from)) ctx.filesWrittenThisTurn.add(to);
			return toolResult(`Moved ${from} to ${to}.`);
		} catch (e) {
			return toolResult(toolInvokeError('fs_move', e));
		}
	}
});
