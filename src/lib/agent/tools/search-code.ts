/**
 * `search_code`: the Search helper's tool (Settings → Code → Helpers). Finds
 * code from a question in plain words: `code_search_candidates` scores chunks
 * of the project's files by the query's words, a reranker set on the Search
 * row reorders them when there is one, and this returns the best few as
 * numbered snippets with their paths. A reranker that fails or is slow leaves
 * the keyword order, and the result says so.
 */
import { invoke } from '@tauri-apps/api/core';
import { ctxCwd, ctxWslDistroArg, labelArg, toolInvokeError } from '#lib/agent/tools/_helpers.ts';
import { helperConfig } from '#lib/helpers/registry.ts';
import type { SearchConfig } from '#lib/helpers/search/config.ts';
import { rerankDocuments } from '#lib/rerank.ts';
import { errMessage } from '#lib/utils/error.ts';
import { urlForReport } from '#lib/utils/http.ts';
import { withLocalScopeNote } from '#lib/agent/tools/_nestedSession.ts';
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolError, toolResult, type ToolExecOutput } from '#lib/agent/tools/types.ts';
import type { SearchCandidates } from '#lib/ipc/gen/SearchCandidates.ts';
import type { SearchChunk } from '#lib/ipc/gen/SearchChunk.ts';

/** How many keyword candidates to ask for. */
const CANDIDATES = 100;
/** How many chunks the agent sees, before touching ones merge. */
const SHOWN = 6;
/** The most a rerank may take before keyword ranking stands. */
const RERANK_TIMEOUT_MS = 15_000;

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

/**
 * The chunks in the order a reranker set on the Search row gives them, with a
 * note naming what ranked them. No reranker, or one that fails: keyword order.
 */
export async function rankChunks(
	query: string,
	chunks: SearchChunk[]
): Promise<{ chunks: SearchChunk[]; ranking: string }> {
	const endpoint = helperConfig<SearchConfig>('search')?.rerank;
	if (!endpoint || chunks.length === 0) return { chunks, ranking: 'keyword ranking' };
	try {
		const res = await rerankDocuments(
			endpoint,
			query,
			chunks.map((c) => `${c.path}\n${c.text}`),
			RERANK_TIMEOUT_MS
		);
		const ranked = res.order.map((o) => chunks[o.index]).filter((c) => c !== undefined);
		return { chunks: ranked, ranking: `reranked by ${endpoint.model}` };
	} catch (e) {
		const reason = errMessage(e).split('\n')[0].slice(0, 120);
		console.warn(`search_code: rerank at ${urlForReport(endpoint.url)} failed: ${reason}`);
		return { chunks, ranking: `keyword ranking: the reranker didn't answer — ${reason}` };
	}
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
				'Call this before code_grep or reading files when you don\'t know the identifier. Finds the code that answers a question in plain words ("where is X handled", "what decides Y") and returns the best few snippets with paths and line numbers. Use code_grep when you already know the exact name.',
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
			const ranked = await rankChunks(args.query as string, res.chunks);
			const out = formatSnippets(pickSnippets(ranked.chunks), res.terms, ranked.ranking);
			return toolResult(await withLocalScopeNote(out, ctx));
		} catch (e) {
			return toolResult(toolInvokeError('code_search_candidates', e));
		}
	}
});
