/**
 * Always-on debug logger for the agent loop.
 *
 * Every API call, agent-loop iteration, recovery branch, and tool start /
 * end pushes a structured line into this in-memory ring buffer. The Log
 * Viewer's "Debug" tab renders the full buffer; the chat UI's "Copy debug
 * log" button on error messages filters it down to a single failing turn
 * via `getDebugLogsForTurn`.
 *
 * Why always on instead of toggle-gated: the failure mode this exists to
 * diagnose (model "gives up" with an empty answer) is rare enough that
 * "enable the toggle, hope you can reproduce" was the wrong workflow —
 * by the time the user hits the bug, the data they need was never
 * captured. Memory cost is bounded (5000-entry ring buffer, large
 * payloads truncated below); CPU cost is dwarfed by the inference round
 * trips it's logging; and the buffer lives entirely in memory and dies
 * on app restart, so persistence/privacy exposure is minimal.
 */

const RING_CAPACITY = 5000;

let nextTurnId = 1;
let activeTurnId: number | null = null;
interface DebugEntry {
	line: string;
	turnId: number | null;
}
const buffer: DebugEntry[] = [];

/**
 * Mark the start of a new agent turn. Returns an opaque turn id that
 * subsequent `logDebug` calls are tagged with until the next `beginTurn`.
 * The chat store stashes the returned id alongside any error it surfaces
 * so the UI can offer a "copy debug log for this failure" action that
 * filters the buffer down to just the entries from the failing turn.
 */
export function beginTurn(): number {
	const id = nextTurnId++;
	activeTurnId = id;
	return id;
}

/**
 * Append a structured line to the debug buffer. `data`, if present, is
 * JSON-serialized and appended after the message — large payloads are
 * truncated so a single multi-megabyte tool result can't blow out the
 * buffer in one entry. The entry is tagged with the active turn id so
 * `getDebugLogsForTurn` can later return only the lines for one specific
 * agent turn (used by the per-failure "copy debug log" button).
 */
export function logDebug(category: string, message: string, data?: unknown): void {
	const ts = new Date().toISOString();
	const turnTag = activeTurnId != null ? ` [turn ${activeTurnId}]` : '';
	let line = `[${ts}]${turnTag} [${category}] ${message}`;
	if (data !== undefined) {
		let serialized: string;
		try {
			serialized = typeof data === 'string' ? data : JSON.stringify(data, jsonReplacer);
		} catch (e) {
			serialized = `<unserializable: ${(e as Error).message}>`;
		}
		const MAX = 20000;
		if (serialized.length > MAX) {
			serialized = serialized.slice(0, MAX) + `… (truncated, ${serialized.length} chars total)`;
		}
		line += ` ${serialized}`;
	}
	if (buffer.length >= RING_CAPACITY) buffer.shift();
	buffer.push({ line, turnId: activeTurnId });
}

/**
 * JSON.stringify replacer that strips embedded data URLs (multimodal
 * image attachments) down to a short marker. Without this, logging a
 * single message-history payload that contains an image would dump
 * hundreds of KB of base64 into one line.
 */
function jsonReplacer(_key: string, value: unknown): unknown {
	if (typeof value === 'string' && value.startsWith('data:') && value.length > 200) {
		return `<data-url len=${value.length}>`;
	}
	return value;
}

export function getDebugLogs(): string[] {
	return buffer.map((e) => e.line);
}

/**
 * Return only the entries tagged with the given turn id. Used by the
 * error UI to copy a single failure's worth of log output.
 */
export function getDebugLogsForTurn(turnId: number): string[] {
	return buffer.filter((e) => e.turnId === turnId).map((e) => e.line);
}

export function clearDebugLogs(): void {
	buffer.length = 0;
}
