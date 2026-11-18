/**
 * Compaction for Code sessions: a summary stands in for the thread's older
 * turns, so a long session neither runs out of window nor leans on the
 * per-request context fit, which forgets what it drops and moves the start
 * of the prompt on every turn (losing the server's prompt cache).
 *
 * The thread itself is never rewritten. The saved `CodeCompaction` marks
 * where the summary ends, `modelThread` builds what the model is sent from
 * it, and the transcript, forks and index-keyed sidecars keep every message
 * where it was. Chat's compaction (`agent/compaction.ts`) rewrites its
 * history instead; a coding session's scrollback is worth more.
 *
 * See plan/code-compaction/.
 */

import { messageText, type BackendOverride, type ChatMessage } from '#lib/api.ts';
import { estimateMessagesTokens, getTokenCalibration } from '#lib/agent/contextBudget.ts';
import { answerForSummary, summarizeInChunks } from '#lib/agent/summarize.ts';
import { resolveBackendDescriptor } from '#lib/inference/descriptor.ts';
import { truncateCapturedOutput } from '#lib/shell/truncate.ts';
import { isReadOnlyCommand } from '#lib/code/readOnlyCommand.ts';
import type { CodeCompaction } from '#lib/code/session.ts';

export { summaryMaxTokens } from '#lib/agent/summarize.ts';

/**
 * Compact once the prompt reaches this share of the window. Below Chat's 0.8:
 * a Code turn grows far more within itself than a chat turn does, and the
 * fit starts dropping turns at the window's edge.
 */
export const COMPACT_AT = 0.75;
/** The newest turns kept verbatim, as a share of the window. */
const KEEP_RECENT = 0.25;
/** A tool result in the summary's input: its head and tail, this many bytes. */
const RESULT_CLIP_BYTES = 1200;
/** A tool call's main argument in the summary's input. */
const ARG_CLIP_CHARS = 120;

const SUMMARY_HEADER =
	"[Summary of this session's earlier turns. Files may have changed since: " +
	'read a file again rather than relying on this.]';

const SUMMARY_PROMPT = `You summarise a coding session between a user and an AI coding assistant working in a project folder, so the assistant can carry on without the turns you summarise. Write plain prose and short lists under these headings, leaving out any with nothing to say:
Task: what the user wants, and how that changed.
Instructions: what the user told the assistant to do or not do, and preferences they stated.
Decisions: what was decided, and why.
Files: files created, changed or deleted, by path, and what changed.
Commands: commands run and what came of them (builds, test results, errors), and every commit, stash, checkout, reset or other change to git state.
Tried and failed: approaches that did not work, and why.
State: where the work stands and what is left to do.
Keep paths, names, commands and error messages exact. File contents are not kept, so name the files that matter rather than describing what is in them. Output only the summary.`;

/**
 * Heads the list of what the summarised turns changed, kept below the
 * model's summary. Written here from the tool calls, not by the model, so it
 * can't be summarised away: a session that lost a stash and a commit in a
 * compaction told the user another agent was changing their repository
 * (#1116), when the changes were its own.
 */
const ACTIONS_HEADER =
	'Changes you made in those turns, from your own tool calls (oldest first). Anything on disk these explain is your own work:';
/** Changes the list keeps, newest; older ones are counted. */
const MAX_ACTIONS = 80;
/** A command or path in the list. */
const ACTION_CLIP_CHARS = 200;

/** Tools that change files without a command. */
const WRITING_TOOL = /^fs_(write|edit|delete|move|download)/;

/** A tool result that is an error (`toolError`'s envelope). */
function failed(result: string | undefined): boolean {
	return result?.trimStart().startsWith('{"error"') ?? false;
}

/**
 * One line per call in `messages` that may have changed something on disk:
 * a file tool that writes, or a command that isn't read-only.
 */
export function actionLines(messages: ChatMessage[]): string[] {
	const results = new Map<string, string>();
	for (const m of messages) {
		if (m.role === 'tool' && m.tool_call_id) results.set(m.tool_call_id, messageText(m.content));
	}
	const out: string[] = [];
	for (const m of messages) {
		if (m.role !== 'assistant') continue;
		for (const c of m.tool_calls ?? []) {
			const name = c.function.name;
			let args: Record<string, unknown> = {};
			try {
				args = JSON.parse(c.function.arguments) as Record<string, unknown>;
			} catch {
				// Unparseable arguments: the call did nothing.
				continue;
			}
			let what: string | null = null;
			if (name === 'run_command' && typeof args.command === 'string') {
				if (!isReadOnlyCommand(args.command)) what = args.command;
			} else if (WRITING_TOOL.test(name)) {
				const target = ['path', 'from', 'url'].find((k) => typeof args[k] === 'string');
				what = target ? String(args[target]) : '';
				if (typeof args.to === 'string') what += ` → ${args.to}`;
			}
			if (what === null) continue;
			const clipped = what.replace(/\s+/g, ' ').slice(0, ACTION_CLIP_CHARS);
			out.push(`- ${name}: ${clipped}${failed(results.get(c.id)) ? ' (failed)' : ''}`);
		}
	}
	return out;
}

/** A summary split into the model's prose and the list of changes below it. */
function splitSummary(summary: string): { prose: string; actions: string[] } {
	const at = summary.indexOf(ACTIONS_HEADER);
	if (at < 0) return { prose: summary, actions: [] };
	const actions = summary
		.slice(at + ACTIONS_HEADER.length)
		.split('\n')
		.filter((l) => l.startsWith('- ') || l.startsWith('('));
	return { prose: summary.slice(0, at).trimEnd(), actions };
}

/** The model's summary with the list of changes, the newest MAX_ACTIONS of them. */
function withActions(prose: string, earlier: string[], now: string[]): string {
	// A count of those dropped before, carried forward.
	let dropped = 0;
	const lines: string[] = [];
	for (const l of [...earlier, ...now]) {
		const m = /^\((\d+) earlier/.exec(l);
		if (m) dropped += Number(m[1]);
		else lines.push(l);
	}
	if (lines.length > MAX_ACTIONS) {
		dropped += lines.length - MAX_ACTIONS;
		lines.splice(0, lines.length - MAX_ACTIONS);
	}
	if (lines.length === 0) return prose;
	const head = dropped ? [`(${dropped} earlier changes not listed)`] : [];
	return `${prose}\n\n${ACTIONS_HEADER}\n${[...head, ...lines].join('\n')}`;
}

/**
 * What the model is sent: the summary note, then the messages after it.
 * `header` heads the summary (the Shell tab passes its own).
 */
export function modelThread(
	s: {
		messages: ChatMessage[];
		compaction?: CodeCompaction | null;
	},
	header = SUMMARY_HEADER
): ChatMessage[] {
	const c = s.compaction;
	if (!c) return s.messages;
	// A system message, merged into the system prompt by
	// `mergeLeadingSystemMessages`: it then sits in the prompt's fixed prefix,
	// unchanged from turn to turn until the next compaction.
	return [{ role: 'system', content: `${header}\n\n${c.summary}` }, ...s.messages.slice(c.at)];
}

/**
 * Compact now? `view` is what the model would be sent (see `modelThread`);
 * `overhead` is what goes with it that the thread doesn't hold, such as the
 * system prompt and tool schemas, in the same raw estimate.
 */
export function shouldCompactCode(
	view: ChatMessage[],
	contextSize: number,
	overhead = 0,
	/** The backend's `calibrationKey`. */
	calibrationKey?: string
): boolean {
	if (contextSize <= 0) return false;
	const estimated = (estimateMessagesTokens(view) + overhead) * getTokenCalibration(calibrationKey);
	return estimated >= contextSize * COMPACT_AT;
}

/**
 * Compact before this turn? `prompt` is the whole outgoing prompt, system
 * prompt included. `lastPromptTokens` is what the server counted for the
 * session's last call, which also covers the tool schemas; 0 when unknown.
 */
export function compactionDue(
	prompt: ChatMessage[],
	contextSize: number,
	lastPromptTokens = 0,
	/** The backend's `calibrationKey`. */
	calibrationKey?: string
): boolean {
	if (contextSize <= 0) return false;
	return (
		shouldCompactCode(prompt, contextSize, 0, calibrationKey) ||
		lastPromptTokens >= contextSize * COMPACT_AT
	);
}

/**
 * Where a turn opens: each user message, whether typed, a watch notice or
 * steering. Cutting before one never separates a tool call from its results,
 * which always directly follow the call.
 */
function turnOpenings(messages: ChatMessage[], after: number): number[] {
	const out: number[] = [];
	for (let i = after + 1; i < messages.length; i++) {
		if (messages[i].role === 'user') out.push(i);
	}
	return out;
}

/**
 * Where to cut: the opening of the oldest turn to keep verbatim. Keeps the
 * newest turns up to KEEP_RECENT of the window, and always the last one.
 * Null when everything past `from` (the current cut) would be kept anyway:
 * summarising a few small turns saves nothing.
 */
export function chooseCut(
	messages: ChatMessage[],
	from: number,
	contextSize: number,
	/** The backend's `calibrationKey`. */
	calibrationKey?: string
): number | null {
	const openings = turnOpenings(messages, from);
	if (openings.length === 0) return null;
	const keep = (contextSize * KEEP_RECENT) / getTokenCalibration(calibrationKey);
	if (estimateMessagesTokens(messages.slice(from)) <= keep) return null;
	let cut = openings[openings.length - 1];
	let tail = estimateMessagesTokens(messages.slice(cut));
	for (let k = openings.length - 2; k >= 0; k--) {
		const at = openings[k];
		const more = estimateMessagesTokens(messages.slice(at, cut));
		if (tail + more > keep) break;
		tail += more;
		cut = at;
	}
	return cut > from ? cut : null;
}

/** `name(main argument)`, for a call in the summary's input. */
function callLabel(name: string, args: string): string {
	try {
		const parsed = JSON.parse(args) as Record<string, unknown>;
		const key = ['path', 'relPath', 'command', 'pattern', 'query', 'url'].find(
			(k) => typeof parsed[k] === 'string'
		);
		if (key) return `${name}(${String(parsed[key]).slice(0, ARG_CLIP_CHARS)})`;
	} catch {
		// Unparseable arguments: the name alone still says what was done.
	}
	return name;
}

function renderMessage(m: ChatMessage): string {
	const text = messageText(m.content);
	switch (m.role) {
		case 'user': {
			const images =
				typeof m.content === 'string' ? 0 : m.content.filter((p) => p.type === 'image_url').length;
			return `User: ${text}${images ? ` [${images} image(s)]` : ''}`;
		}
		case 'assistant': {
			const prose = answerForSummary(text);
			const calls = (m.tool_calls ?? []).map(
				(c) => `→ ${callLabel(c.function.name, c.function.arguments)}`
			);
			return [prose && `Assistant: ${prose}`, ...calls].filter(Boolean).join('\n');
		}
		case 'tool':
			return `← ${truncateCapturedOutput(text, RESULT_CLIP_BYTES).text}`;
		default:
			return `Note: ${text}`;
	}
}

/**
 * The span as compact text, one string per turn: calls as `→ name(arg)`,
 * results clipped to head and tail, reasoning removed. The summary needs
 * what happened, not the file bodies a turn read.
 */
export function renderForSummary(messages: ChatMessage[]): string[] {
	const turns: string[][] = [];
	for (const m of messages) {
		if (m.role === 'user' || turns.length === 0) turns.push([]);
		const line = renderMessage(m);
		if (line) turns[turns.length - 1].push(line);
	}
	return turns.map((t) => t.join('\n')).filter(Boolean);
}

/**
 * Roll a summary forward over `turns` (`summarizeInChunks`), with the prompt
 * written for coding unless the caller passes its own.
 */
export function summarizeTurns(opts: {
	previous: string | null;
	turns: string[];
	backend: BackendOverride | null;
	contextSize: number;
	signal?: AbortSignal;
	/** What the user asked to keep (`/compact <text>`). */
	instructions?: string;
	prompt?: string;
}): Promise<string> {
	const { turns, prompt = SUMMARY_PROMPT, ...rest } = opts;
	return summarizeInChunks({ ...rest, prompt, parts: turns });
}

/**
 * Summarise the thread up to a new cut. Null when there is nothing new to
 * summarise. Throws when the model call does; the caller carries on without.
 */
export async function compactCodeThread(opts: {
	messages: ChatMessage[];
	compaction: CodeCompaction | null;
	backend: BackendOverride | null;
	contextSize: number;
	signal?: AbortSignal;
	instructions?: string;
	/** The summary prompt, when not the coding one (the Shell tab's). */
	prompt?: string;
}): Promise<CodeCompaction | null> {
	const from = opts.compaction?.at ?? 0;
	const at = chooseCut(
		opts.messages,
		from,
		opts.contextSize,
		resolveBackendDescriptor(opts.backend ?? undefined).calibrationKey
	);
	if (at === null) return null;
	const previous = opts.compaction ? splitSummary(opts.compaction.summary) : null;
	const span = opts.messages.slice(from, at);
	const prose = await summarizeTurns({
		previous: previous?.prose ?? null,
		turns: renderForSummary(span),
		backend: opts.backend,
		contextSize: opts.contextSize,
		signal: opts.signal,
		instructions: opts.instructions,
		prompt: opts.prompt
	});
	const summary = withActions(prose, previous?.actions ?? [], actionLines(span));
	return { at, summary, summarizedAt: Date.now() };
}
