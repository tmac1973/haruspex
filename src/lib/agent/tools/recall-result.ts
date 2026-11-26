/**
 * `recall_result`: the exact text of a tool result the context fit trimmed
 * from this turn's prompt, by the id its stub gives (`RecallArchive`).
 *
 * Reading it back is not the same as running the tool again: output and pages
 * change, a command may have side effects, and a long run costs time. A page
 * at a time, or only the lines that match a pattern, so one recall does not
 * fill the window the trim just freed.
 */

import { RECALL_TOOL } from '#lib/agent/recallArchive.ts';
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolError, toolResult } from '#lib/agent/tools/types.ts';

/** The most one call returns, in characters (about 4.5K tokens). */
const PAGE_CHARS = 16_000;
/** Lines kept on each side of a pattern match. */
const CONTEXT_LINES = 2;

registerTool({
	category: 'recall',
	schema: {
		type: 'function',
		function: {
			name: RECALL_TOOL,
			description:
				'Read back the exact text of a trimmed tool result, by the id in its stub, instead of running the tool again.',
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'From the stub, e.g. "r3".' },
					offset: { type: 'integer', description: 'Character to start at.' },
					pattern: { type: 'string', description: 'Only lines containing this, numbered.' }
				},
				required: ['id']
			}
		}
	},
	displayLabel: (args) => String(args.id ?? ''),
	async execute(args, ctx) {
		const archive = ctx.recallArchive;
		if (!archive || archive.size === 0) {
			return toolResult(
				toolError('Nothing has been trimmed this turn, so there is nothing to recall.')
			);
		}
		const id = typeof args.id === 'string' ? args.id : '';
		const kept = archive.get(id);
		if (!kept) {
			return toolResult(
				toolError(
					`No trimmed result "${id}". Ids come from this turn's stubs and last only for this turn.`
				)
			);
		}
		const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : '';
		if (pattern) return toolResult(matching(kept.id, kept.call, kept.text, pattern));
		const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
		return toolResult(page(kept.id, kept.call, kept.text, offset));
	}
});

function page(id: string, call: string, text: string, offset: number): string {
	const end = Math.min(text.length, offset + PAGE_CHARS);
	const head = `Result ${id} (${call}), characters ${offset}–${end} of ${text.length}:\n\n`;
	const more = end < text.length ? `\n\n[More: ${RECALL_TOOL} id="${id}" offset=${end}]` : '';
	return head + text.slice(offset, end) + more;
}

function matching(id: string, call: string, text: string, pattern: string): string {
	const lines = text.split('\n');
	const needle = pattern.toLowerCase();
	const keep = new Set<number>();
	let hits = 0;
	lines.forEach((line, i) => {
		if (!line.toLowerCase().includes(needle)) return;
		hits++;
		for (let j = i - CONTEXT_LINES; j <= i + CONTEXT_LINES; j++) {
			if (j >= 0 && j < lines.length) keep.add(j);
		}
	});
	const head = `Result ${id} (${call}): ${hits} of ${lines.length} lines contain "${pattern}".`;
	if (hits === 0) return head;
	let out = head + '\n';
	let last = -2;
	for (const i of [...keep].sort((a, b) => a - b)) {
		const line = `${i > last + 1 ? '--\n' : ''}${i + 1}: ${lines[i]}\n`;
		if (out.length + line.length > PAGE_CHARS) {
			return out + '[Cut: narrow the pattern, or read pages with offset.]';
		}
		out += line;
		last = i;
	}
	return out.trimEnd();
}
