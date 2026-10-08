/**
 * Tool calls the model is still writing, as the Code tab shows them: a row per
 * call with what it is about to do, read out of argument JSON that is not
 * finished yet.
 */

import type { PartialToolCall } from '#lib/agent/loop.ts';

/** A call in the round in flight; `index` is its position in that round. */
export interface PendingToolCall extends PartialToolCall {
	index: number;
}

/** Add or update the call at `index`, keeping the list in index order. */
export function upsertPendingCall(
	calls: PendingToolCall[],
	index: number,
	call: PartialToolCall
): PendingToolCall[] {
	const next = calls.filter((c) => c.index !== index);
	next.push({ ...call, index });
	return next.sort((a, b) => a.index - b.index);
}

/**
 * Drop the pending row for a call that has started running: the one with its
 * id, or, when the stream gave none, the first with its name.
 */
export function dropPendingCall(
	calls: PendingToolCall[],
	started: { id: string; name: string }
): PendingToolCall[] {
	let k = calls.findIndex((c) => c.id === started.id);
	if (k < 0) k = calls.findIndex((c) => !c.id && c.name === started.name);
	return k < 0 ? calls : calls.filter((_, i) => i !== k);
}

const ESCAPES: Record<string, string> = {
	'"': '"',
	'\\': '\\',
	'/': '/',
	b: '\b',
	f: '\f',
	n: '\n',
	r: '\r',
	t: '\t'
};

/**
 * The string value of `key` in a JSON object that may be cut off anywhere,
 * decoded as far as it goes. Null when the key, or the start of its string
 * value, hasn't arrived. An escape split by the cut is left off.
 *
 * Lenient on purpose: it matches the first `"key": "` anywhere, so a nested
 * object with the same key could be read instead. The tools it serves take
 * flat string arguments.
 */
export function partialJsonString(json: string, key: string): string | null {
	const quoted = JSON.stringify(key);
	const re = new RegExp(`${escapeRegExp(quoted)}\\s*:\\s*"`);
	const m = re.exec(json);
	if (!m) return null;
	let out = '';
	for (let i = m.index + m[0].length; i < json.length; i++) {
		const ch = json[i];
		if (ch === '"') return out;
		if (ch !== '\\') {
			out += ch;
			continue;
		}
		const next = json[i + 1];
		if (next === undefined) return out;
		if (next === 'u') {
			const hex = json.slice(i + 2, i + 6);
			if (!/^[0-9a-fA-F]{4}$/.test(hex)) return out;
			out += String.fromCharCode(parseInt(hex, 16));
			i += 5;
		} else {
			out += ESCAPES[next] ?? next;
			i += 1;
		}
	}
	return out;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** "812 B", "4.2 KB", "1.3 MB". */
export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export interface PendingCallLabel {
	/** "Writing", "Editing", "Preparing command…", "Calling fs_grep…". */
	verb: string;
	/** The file the call names, once its path has arrived. */
	path?: string;
	/** The command text, once it has arrived. */
	command?: string;
	/** How much file content has been written so far, for a write. */
	size?: string;
}

/** What the row for a call still being written says. */
export function describePendingCall(call: PartialToolCall): PendingCallLabel {
	const args = call.argsSoFar;
	switch (call.name) {
		case 'fs_write_text': {
			const path = partialJsonString(args, 'path') ?? undefined;
			const content = partialJsonString(args, 'content');
			const size = content ? formatBytes(new TextEncoder().encode(content).length) : undefined;
			return { verb: 'Writing', path, size };
		}
		case 'fs_edit_text':
			return { verb: 'Editing', path: partialJsonString(args, 'path') ?? undefined };
		case 'run_command': {
			const command = partialJsonString(args, 'command');
			return { verb: 'Preparing command…', ...(command ? { command } : {}) };
		}
		default:
			return { verb: call.name ? `Calling ${call.name}…` : 'Calling a tool…' };
	}
}
