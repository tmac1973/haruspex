/**
 * `search_code`: the Search helper's tool (Settings → Code → Helpers). Finds
 * code from a question in plain words: `code_search_candidates` scores chunks
 * of the project's files by the query's words, and this returns the best few
 * as numbered snippets with their paths.
 */
import { invoke } from '@tauri-apps/api/core';
import { ctxCwd, ctxWslDistroArg, labelArg, toolInvokeError } from '#lib/agent/tools/_helpers.ts';
import { withLocalScopeNote } from '#lib/agent/tools/nested-session.ts';
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolError, toolResult, type ToolExecOutput } from '#lib/agent/tools/types.ts';
import type { SearchCandidates } from '#lib/ipc/gen/SearchCandidates.ts';
import type { SearchChunk } from '#lib/ipc/gen/SearchChunk.ts';

/** How many keyword candidates to ask for. */
const CANDIDATES = 100;
/** How many chunks the agent sees, before touching ones merge. */
const SHOWN = 6;

export interface Snippet {
	path: string;
	start: number;
	end: number;
	lines: string[];
}

/**
 * The first `SHOWN` chunks as snippets, in rank order. Two in one file whose
 * line ranges touch or overlap become one snippet, at the better one's place,
 * so six chunks can be fewer snippets.
 */
export function pickSnippets(chunks: SearchChunk[]): Snippet[] {
	const out: Snippet[] = [];
	for (const c of chunks.slice(0, SHOWN)) {
		const lines = c.text.split('\n');
		const near = out.find(
			(s) => s.path === c.path && c.start_line <= s.end + 1 && c.end_line >= s.start - 1
		);
		if (!near) {
			out.push({ path: c.path, start: c.start_line, end: c.end_line, lines });
			continue;
		}
		const byLine = new Map<number, string>();
		near.lines.forEach((l, i) => byLine.set(near.start + i, l));
		lines.forEach((l, i) => byLine.set(c.start_line + i, l));
		near.start = Math.min(near.start, c.start_line);
		near.end = Math.max(near.end, c.end_line);
		near.lines = [];
		for (let n = near.start; n <= near.end; n++) near.lines.push(byLine.get(n) ?? '');
	}
	return out;
}

/** The snippets as `== path:start-end` and numbered lines, then what ranked them. */
export function formatSnippets(snippets: Snippet[], terms: string[], ranking: string): string {
	if (snippets.length === 0) {
		return `No matches for: ${terms.join(' ')}. Try other words, or code_grep for an identifier.\n(${ranking})`;
	}
	const blocks = snippets.map((s) =>
		[`== ${s.path}:${s.start}-${s.end}`, ...s.lines.map((l, i) => `${s.start + i}: ${l}`)].join(
			'\n'
		)
	);
	return `${blocks.join('\n\n')}\n\n(${ranking})`;
}

registerTool({
	category: 'fs',
	schema: {
		type: 'function',
		function: {
			name: 'search_code',
			description:
				'Find the code that answers a question in plain words ("where is X handled", "what decides Y"). Returns the best few snippets with paths and line numbers. Use this first when you don\'t know the exact identifier; use code_grep when you do.',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'The question, in plain words.' },
					path: { type: 'string', description: 'Optional subdirectory to limit the search.' }
				},
				required: ['query']
			}
		}
	},
	displayLabel: labelArg('query'),
	async execute(args, ctx): Promise<ToolExecOutput> {
		const root = ctxCwd(ctx);
		if (!root) return toolResult(toolError('No working directory set.'));
		try {
			const res = await invoke<SearchCandidates>('code_search_candidates', {
				root,
				query: args.query as string,
				path: (args.path as string) ?? null,
				limit: CANDIDATES,
				...ctxWslDistroArg(ctx)
			});
			const out = formatSnippets(pickSnippets(res.chunks), res.terms, 'keyword ranking');
			return toolResult(await withLocalScopeNote(out, ctx));
		} catch (e) {
			return toolResult(toolInvokeError('code_search_candidates', e));
		}
	}
});
