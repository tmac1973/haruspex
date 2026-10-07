/**
 * Running one response's tool calls side by side.
 *
 * A model researching a question asks for four pages in one response; read one
 * after another, each page's fetch and summary waits on the last. On a server
 * that runs several requests at once there is no reason to: the reads are
 * independent, and their summaries are separate model calls.
 *
 * Only read-only tools share a batch. Anything that writes, runs a command,
 * asks the user or loads images runs alone, in its place, so the order the
 * model asked for is the order things happen. Results always go back to the
 * model in call order, whatever order they finished in.
 */

import type { ResolvedToolCall } from '#lib/agent/parser.ts';

/**
 * Tools with no side effects on the turn: no writes, no pending images, no
 * questions. fs_read_image and fs_read_pdf_pages are left out because they
 * add to the turn's pending images and check the count first.
 */
const PARALLEL_SAFE_TOOLS = new Set([
	'web_search',
	'fetch_url',
	'research_url',
	'image_search',
	'fs_list_dir',
	'fs_read_text',
	'fs_read_pdf',
	'fs_read_docx',
	'fs_read_xlsx'
]);

/** The most calls one response runs at once, even on an unbounded lane. */
export const MAX_PARALLEL_TOOL_CALLS = 4;

/** Lower caps for tools whose upstream rate-limits a burst. */
const PER_TOOL_CAP: Record<string, number> = {
	// The search engines answer a burst with a bot check.
	web_search: 2
};

/**
 * How many tool calls run at once on a lane that admits `laneLimit` turns
 * (null: parallel, limit unknown). A serialized lane gets 1 — tools run one
 * at a time, as they always have.
 */
export function toolCallConcurrency(laneLimit: number | null): number {
	if (laneLimit !== null && laneLimit <= 1) return 1;
	return Math.min(MAX_PARALLEL_TOOL_CALLS, laneLimit ?? MAX_PARALLEL_TOOL_CALLS);
}

/**
 * Split calls into batches that may run concurrently: each run of
 * consecutive read-only calls is one batch, and every other call is a batch
 * of its own.
 */
export function planToolBatches(calls: ResolvedToolCall[]): ResolvedToolCall[][] {
	const batches: ResolvedToolCall[][] = [];
	let open: ResolvedToolCall[] | null = null;
	for (const call of calls) {
		if (PARALLEL_SAFE_TOOLS.has(call.name)) {
			if (!open) {
				open = [];
				batches.push(open);
			}
			open.push(call);
		} else {
			open = null;
			batches.push([call]);
		}
	}
	return batches;
}

/**
 * Run `run` over `calls` with at most `limit` in flight (and at most a tool's
 * own cap of that tool), handing each result to `onResult` in call order as
 * soon as every earlier call has finished. Rejects on the first failure; the
 * calls still in flight are left to finish unobserved, as an aborted tool
 * always has been.
 */
export function runToolBatch<T>(
	calls: ResolvedToolCall[],
	limit: number,
	run: (call: ResolvedToolCall) => Promise<T>,
	onResult: (call: ResolvedToolCall, result: T) => void
): Promise<void> {
	const n = calls.length;
	const results: T[] = new Array(n);
	const done: boolean[] = new Array(n).fill(false);
	const waiting = calls.map((_, i) => i);
	const activeByTool = new Map<string, number>();
	let running = 0;
	let nextToDeliver = 0;
	let failed = false;

	return new Promise<void>((resolve, reject) => {
		const fail = (e: unknown) => {
			if (failed) return;
			failed = true;
			reject(e);
		};

		const deliver = () => {
			while (nextToDeliver < n && done[nextToDeliver]) {
				try {
					onResult(calls[nextToDeliver], results[nextToDeliver]);
				} catch (e) {
					fail(e);
					return;
				}
				nextToDeliver++;
			}
			if (nextToDeliver === n) resolve();
		};

		const startMore = () => {
			while (!failed && running < limit) {
				const pos = waiting.findIndex((i) => {
					const name = calls[i].name;
					return (activeByTool.get(name) ?? 0) < (PER_TOOL_CAP[name] ?? limit);
				});
				if (pos < 0) return;
				const i = waiting.splice(pos, 1)[0];
				const name = calls[i].name;
				running++;
				activeByTool.set(name, (activeByTool.get(name) ?? 0) + 1);
				// Deferred a tick so `run` never starts inside this loop's
				// bookkeeping, and a synchronous throw becomes a rejection.
				Promise.resolve()
					.then(() => run(calls[i]))
					.then(
						(result) => {
							if (failed) return;
							results[i] = result;
							done[i] = true;
							running--;
							activeByTool.set(name, (activeByTool.get(name) ?? 1) - 1);
							deliver();
							startMore();
						},
						(e) => fail(e)
					);
			}
		};

		if (n === 0) resolve();
		else startMore();
	});
}
