/**
 * `recall_result`: the exact text of a tool result the context fit trimmed
 * from this turn's prompt, by the id its stub gives (`RecallArchive`).
 *
 * Reading it back is not the same as running the tool again: output and pages
 * change, a command may have side effects, and a long run costs time. A page
 * at a time, or only the lines that match a pattern, so one recall does not
 * fill the window the trim just freed.
 *
 * `offset` and `limit` count lines from 1, as `fs_read_text`'s do. They
 * counted characters at first, and in a live run the model passed line
 * numbers to it anyway — `offset: 587` on five files — and read the wrong
 * slices (#1022).
 */

import { TOKEN_BYTES_RATIO, estimateTokens } from '#lib/agent/contextBudget.ts';
import { RECALL_TOOL, type RecallArchive } from '#lib/agent/recallArchive.ts';
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolError, toolResult } from '#lib/agent/tools/types.ts';

/** The most one call returns, in characters (about 4.5K tokens). */
const PAGE_CHARS = 16_000;
/** The least a page is cut to when the round has little room left. */
const MIN_PAGE_CHARS = 2_000;
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
					offset: { type: 'integer', description: '1-indexed line to start at.' },
					limit: { type: 'integer', description: 'Most lines to return.' },
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
		const cap = pageCap(archive);
		if (cap === null) {
			return toolResult(
				toolError(
					`Not read: this round's recalls already fill the room in the context. ` +
						`Recall "${kept.id}" in a later call, one at a time, or narrow it with pattern or limit.`
				)
			);
		}
		const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : '';
		const out = pattern
			? matching(kept.id, kept.call, kept.text, pattern, cap)
			: page(kept.id, kept.call, kept.text, lineArg(args.offset, 1), lineArg(args.limit), cap);
		archive.spend(estimateTokens(out));
		return toolResult(out);
	}
});

/**
 * How many characters this call may return: what the round has room for, up
 * to a page. Null when an earlier recall this round already took the room.
 * The round's first recall always gets at least `MIN_PAGE_CHARS`, so the model
 * is never stuck when the prompt already sits near the trim threshold.
 */
function pageCap(archive: RecallArchive): number | null {
	const room = Math.floor(archive.roomLeft * TOKEN_BYTES_RATIO);
	if (room >= MIN_PAGE_CHARS) return Math.min(PAGE_CHARS, room);
	return archive.recalledThisRound ? null : MIN_PAGE_CHARS;
}

/** A positive whole number from a model's argument, or `fallback`. */
function lineArg(value: unknown, fallback?: number): number | undefined {
	const n = Math.floor(Number(value));
	return Number.isFinite(n) && n >= 1 ? n : fallback;
}

function page(
	id: string,
	call: string,
	text: string,
	offset = 1,
	limit: number | undefined,
	cap: number
): string {
	const lines = text.split('\n');
	const total = lines.length;
	const start = Math.min(offset, total);
	const stop = Math.min(total, limit ? start - 1 + limit : total);
	let body = '';
	let last = start - 1;
	for (let i = start - 1; i < stop; i++) {
		const line = (i > start - 1 ? '\n' : '') + lines[i];
		if (body.length + line.length > cap) {
			// One line longer than a page: give its start rather than nothing.
			if (i === start - 1) body = line.slice(0, cap);
			break;
		}
		body += line;
		last = i + 1;
	}
	const shown = last >= start ? `lines ${start}–${last}` : `the start of line ${start}`;
	const head = `Result ${id} (${call}), ${shown} of ${total}:\n\n`;
	const next = Math.max(last + 1, start + 1);
	const more =
		last < total
			? `\n\n[More: ${RECALL_TOOL} id="${id}" offset=${next}${last < start ? ', or narrow it with pattern' : ''}]`
			: '';
	return head + body + more;
}

function matching(id: string, call: string, text: string, pattern: string, cap: number): string {
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
		if (out.length + line.length > cap) {
			return out + '[Cut: narrow the pattern, or read lines with offset and limit.]';
		}
		out += line;
		last = i;
	}
	return out.trimEnd();
}
