/**
 * Code-tab sessions: the registry of open sessions and the `CodeSession`
 * class that runs their turns (`#lib/code/runCodeTurn.ts`). Headless — the
 * tab renders this state, and nothing here needs the tab to exist.
 *
 * A session is identified by its id, never its folder, and the database is the
 * source of truth for its thread: the thread is written after every turn,
 * stopped turns included, so a reload, a crash or a detach are all "load by
 * id".
 *
 * Never imports the shell store; the two share helpers, not state.
 */

import { invoke } from '@tauri-apps/api/core';

import type { BackendOverride, ChatMessage, Usage } from '#lib/api.ts';
import type { AgentsMd } from '#lib/ipc/gen/AgentsMd.ts';
import type { BgProcess } from '#lib/ipc/gen/BgProcess.ts';
import type { SkillDoc } from '#lib/ipc/gen/SkillDoc.ts';
import type { InferenceTicket } from '#lib/agent/inferenceQueue.svelte.ts';
import type { AgentStopReason, SearchStep } from '#lib/agent/loop.ts';
import { markStepDone, markStepProgress } from '#lib/agent/steps.ts';
import { describeContextManaged } from '#lib/agent/context-budget.ts';
import { computeMessageStats, type MessageStats } from '#lib/stores/chat.svelte.ts';
import { codeApprovalKey, resetSessionApproval } from '#lib/stores/codeCommandApproval.svelte.ts';
import { renderSlashMessage } from '#lib/skills/content.ts';
import {
	buildWatchNotification,
	clearCodeWatches,
	consumeWatches,
	peekCompletedCodeWatches,
	setCodeWatchCompletionHandler
} from '#lib/shell/backgroundWatch.ts';
import {
	createCodeSession,
	loadCodeSession,
	saveCodeSession,
	updateCodeSessionMeta,
	type CodeSessionRecord
} from '#lib/code/db.ts';
import { decodeCodeSession, encodeCodeSession, type CodeSessionState } from '#lib/code/session.ts';
import { runCodeTurn, type CodeTurnResult } from '#lib/code/runCodeTurn.ts';
import type { PendingToolCall } from '#lib/code/pendingCall.ts';
import { LiveTurn } from '#lib/code/liveTurn.svelte.ts';
import { isUnsetTitle } from '#lib/code/sessionList.ts';
import { isSlashCommand, nameSession } from '#lib/code/sessionTitle.ts';
import { logDebug } from '#lib/debug-log.ts';
import { errMessage } from '#lib/utils/error.ts';

/**
 * - `queued`: the turn is waiting for an inference slot behind another turn.
 * - `waiting-shell`: the turn handed a command to a Shell tab and waits for
 *   it (`open_in_shell`, phase 6).
 */
export type CodeSessionStatus = 'idle' | 'queued' | 'running' | 'waiting-shell';

/** How often the background-process list is refreshed while any runs. */
const BG_POLL_MS = 3000;
/** Tools whose end can start or stop a background process. */
const BG_TOOLS = new Set(['run_command', 'command_stop']);

export class CodeSession {
	readonly id: string;
	/** The project folder, fixed for the session's life. */
	readonly root: string;
	/** Empty until the session is named (`sessionLabel` shows the folder meanwhile). */
	title = $state('');
	/** Null follows the global backend. */
	backend = $state<BackendOverride | null>(null);
	/** Null follows the global reasoning effort. */
	effort = $state<string | null>(null);

	messages = $state<ChatMessage[]>([]);
	/** Index-keyed sidecars, as the shell store keeps them. */
	messageSteps = $state<Record<number, SearchStep[]>>({});
	messageStats = $state<Record<number, MessageStats>>({});
	messageStops = $state<Record<number, AgentStopReason>>({});
	/** Always empty here (there is no shell history); kept for the snapshot shape. */
	messageHistorySent = $state<Record<number, string[]>>({});

	status = $state<CodeSessionStatus>('idle');
	/** The waiting inference ticket while `status` is 'queued'. */
	ticket = $state<InferenceTicket | null>(null);
	/** Messages typed while a turn runs, not yet given to the model. */
	steering = $state<string[]>([]);
	/** Steering the running turn has given the model. Cleared when it ends. */
	steeringDelivered = $state<string[]>([]);
	/**
	 * Steering the turn ended without delivering (stopped, or out of
	 * iterations), for the input box to take back. See `takeReturnedSteering`.
	 */
	returnedSteering = $state<string[]>([]);
	/** This session's background processes, from `code_bg_status`. */
	background = $state<BgProcess[]>([]);

	/** What the running turn shows while the model writes (`LiveTurn`). */
	private readonly live = new LiveTurn();
	searchSteps = $state<SearchStep[]>([]);
	lastError = $state<string | null>(null);
	/** Set when the last thread save failed, so the UI can say so. */
	saveError = $state<string | null>(null);
	contextNotice = $state<string | null>(null);
	usage = $state<{ promptTokens: number; completionTokens: number; contextSize: number } | null>(
		null
	);
	/** The repo's AGENTS.md as the last turn carried it. */
	agentsMd = $state<AgentsMd | null>(null);
	/** The trusted repo the last turn took instructions from. */
	projectRoot = $state<string | null>(null);

	private abortController: AbortController | null = null;
	/** Settles once the running turn has been saved. */
	private turnDone: Promise<void> | null = null;
	/** The naming call has been made (or is under way); it is made once. */
	private named = false;
	private closed = false;
	/** A watch notification is being put together. */
	private flushing = false;
	private bgTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly unwatch: () => void;

	constructor(record: CodeSessionRecord) {
		this.id = record.id;
		this.root = record.root;
		// A title from a slash command (`/init`) is no name: the next real turn names it.
		this.title = isUnsetTitle(record.title) ? '' : record.title;
		this.backend = record.backend;
		this.effort = record.reasoning_effort;
		// A new session, or a fork at its first message, stores an empty thread,
		// which decodes as null: that is an empty session, not a broken one.
		const thread = decodeCodeSession(record.thread);
		if (thread) {
			this.messages = thread.messages;
			this.messageSteps = thread.messageSteps;
			this.messageStats = thread.messageStats;
			this.messageStops = thread.messageStops;
			this.messageHistorySent = thread.messageHistorySent;
		}
		this.unwatch = setCodeWatchCompletionHandler(this.id, () => {
			void this.flushWatchNotifications();
		});
	}

	/** The answer so far. */
	get streamingContent(): string {
		return this.live.streamingContent;
	}

	/** The tool round in flight: reasoning, then text. See `LiveTurn.roundText`. */
	get roundText(): string {
		return this.live.roundText;
	}

	/** Tool calls the round in flight is writing. */
	get pendingToolCalls(): PendingToolCall[] {
		return this.live.pendingToolCalls;
	}

	get busy(): boolean {
		return this.status !== 'idle';
	}

	/**
	 * Send a message. While a turn runs it is queued as steering instead,
	 * given to the model at the next step (images and skills are not: they
	 * only start a turn).
	 */
	send = async (
		text: string,
		opts: { images?: string[]; skill?: SkillDoc } = {}
	): Promise<void> => {
		const trimmed = text.trim();
		const images = opts.images ?? [];
		if (this.closed || (!trimmed && images.length === 0)) return;
		if (this.busy) {
			if (trimmed) this.steering = [...this.steering, trimmed];
			return;
		}
		const body = opts.skill ? renderSlashMessage(opts.skill, trimmed) : trimmed;
		// The first real message names the session, once its turn is over.
		const namesFrom =
			!this.named && !this.title && trimmed && !opts.skill && !isSlashCommand(trimmed)
				? trimmed
				: null;
		if (namesFrom) this.named = true;
		await this.runTurn(userMessage(body, images));
		if (namesFrom) await this.name(namesFrom);
	};

	/** Resume after a turn limit or forced stop. */
	continueTurn = (): Promise<void> => this.send('Please continue from where you stopped.');

	/** Cancel the running turn. What it finished is saved. */
	stop = (): void => {
		this.abortController?.abort();
	};

	/** Take the steering a finished turn handed back, clearing it. */
	takeReturnedSteering = (): string[] => {
		const texts = this.returnedSteering;
		this.returnedSteering = [];
		return texts;
	};

	/** Null puts the session back on the global backend. Applies from the next turn. */
	setBackend = async (backend: BackendOverride | null): Promise<void> => {
		const prev = this.backend;
		this.backend = backend;
		try {
			await updateCodeSessionMeta(this.id, { backend });
		} catch (e) {
			this.backend = prev;
			throw e;
		}
	};

	/** Null puts the session back on the global effort. Applies from the next turn. */
	setEffort = async (effort: string | null): Promise<void> => {
		const prev = this.effort;
		this.effort = effort;
		try {
			await updateCodeSessionMeta(this.id, { effort });
		} catch (e) {
			this.effort = prev;
			throw e;
		}
	};

	rename = async (title: string): Promise<void> => {
		const next = title.trim();
		if (!next || next === this.title) return;
		const prev = this.title;
		this.title = next;
		this.named = true;
		try {
			await updateCodeSessionMeta(this.id, { title: next });
		} catch (e) {
			this.title = prev;
			throw e;
		}
	};

	/**
	 * Name the session from its first real message: a short model call, or
	 * the message itself when that fails. A title the user gave meanwhile wins.
	 */
	private async name(message: string): Promise<void> {
		const backend = this.backend ? ($state.snapshot(this.backend) as BackendOverride) : null;
		const title = await nameSession(message, backend);
		if (this.title || !title) return;
		try {
			await updateCodeSessionMeta(this.id, { title });
			if (!this.title) this.title = title;
		} catch (e) {
			logDebug('code', 'saving the title failed', { id: this.id, error: errMessage(e) });
		}
	}

	/** Refresh `background`, and keep refreshing while any process runs. */
	refreshBackground = async (): Promise<void> => {
		if (this.closed) return;
		try {
			this.background = await invoke<BgProcess[]>('code_bg_status', { owner: this.id });
		} catch (e) {
			logDebug('code', 'background status failed', { id: this.id, error: errMessage(e) });
		}
		this.scheduleBackgroundPoll();
	};

	/**
	 * Deliver "your watched command finished" as a turn of its own, but only
	 * when idle: during a turn the watches stay queued, and this runs again
	 * once it ends. Everything finished goes in one turn.
	 */
	flushWatchNotifications = async (): Promise<void> => {
		if (this.busy || this.closed || this.flushing) return;
		const completed = peekCompletedCodeWatches(this.id);
		if (completed.length === 0) return;
		this.flushing = true;
		let body: string;
		try {
			body = await buildWatchNotification(completed);
		} finally {
			this.flushing = false;
		}
		// A turn the user started while the logs were read goes first.
		if (this.busy || this.closed) return;
		consumeWatches(completed.map((w) => w.id));
		await this.runTurn({ role: 'user', content: body });
	};

	/** The thread as `encodeCodeSession` takes it. */
	snapshot = (): CodeSessionState => ({
		messages: $state.snapshot(this.messages) as ChatMessage[],
		messageSteps: $state.snapshot(this.messageSteps) as Record<number, SearchStep[]>,
		messageStats: $state.snapshot(this.messageStats),
		messageStops: $state.snapshot(this.messageStops),
		messageHistorySent: $state.snapshot(this.messageHistorySent)
	});

	/**
	 * Stop the turn and let go of everything this session holds in the app.
	 * Resolves once a stopped turn has been saved. Background processes are
	 * the registry's to stop (`closeSession`).
	 */
	dispose = async (): Promise<void> => {
		this.closed = true;
		this.stop();
		this.unwatch();
		clearCodeWatches(this.id);
		resetSessionApproval(codeApprovalKey(this.id));
		if (this.bgTimer !== null) clearTimeout(this.bgTimer);
		this.bgTimer = null;
		await this.turnDone;
	};

	private runTurn(opening: ChatMessage): Promise<void> {
		if (this.busy || this.closed) return Promise.resolve();
		this.status = 'running';
		const done = this.turn(opening).finally(() => {
			this.status = 'idle';
			this.turnDone = null;
			// A watched command may have finished during the turn; deliver it
			// now that the session is idle, once this turn has fully unwound.
			queueMicrotask(() => void this.flushWatchNotifications());
		});
		this.turnDone = done;
		return done;
	}

	private async turn(opening: ChatMessage): Promise<void> {
		this.lastError = null;
		this.contextNotice = null;
		this.clearLive();
		this.returnedSteering = [];
		this.messages = [...this.messages, opening];

		const abort = new AbortController();
		this.abortController = abort;
		let lastCallStats: { durationMs: number; completionTokens: number } | null = null;
		const startedAt = Date.now();

		try {
			const result = await runCodeTurn({
				sessionId: this.id,
				root: this.root,
				thread: $state.snapshot(this.messages) as ChatMessage[],
				backend: this.backend ? ($state.snapshot(this.backend) as BackendOverride) : null,
				effort: this.effort,
				signal: abort.signal,
				takeSteering: () => {
					const texts = this.steering;
					this.steering = [];
					return texts;
				},
				onSteering: (texts) => {
					this.steeringDelivered = [...this.steeringDelivered, ...texts];
				},
				onProject: (project) => {
					this.projectRoot = project.root;
					this.agentsMd = project.agentsMd;
				},
				onTicket: (t) => {
					this.ticket = t;
					this.status = 'queued';
				},
				onAdmitted: () => {
					this.ticket = null;
					this.status = 'running';
				},
				...this.live.callbacks(),
				onCallStats: (stats) => (lastCallStats = stats),
				onUsage: (usage: Usage, contextSize) => {
					this.usage = {
						promptTokens: usage.prompt_tokens,
						completionTokens: usage.completion_tokens,
						contextSize
					};
				},
				onContextManaged: (info) => {
					if (info.kind === 'fit') this.contextNotice = describeContextManaged(info);
				},
				onToolStart: (call, lead) => {
					this.searchSteps = [...this.searchSteps, this.live.startStep(call, lead)];
				},
				onToolProgress: (call, status) => {
					this.searchSteps = markStepProgress(this.searchSteps, call, status);
				},
				onToolEnd: (call, res, thumb, artifacts, fileDiff) => {
					this.searchSteps = markStepDone(this.searchSteps, call, res, thumb, artifacts);
					if (fileDiff) {
						this.searchSteps = this.searchSteps.map((s) =>
							s.id === call.id ? { ...s, fileDiff } : s
						);
					}
					if (BG_TOOLS.has(call.name)) void this.refreshBackground();
				}
			});
			this.commit(result, lastCallStats, startedAt);
		} catch (e) {
			// runCodeTurn reports failures in its result; this is a bug guard.
			this.lastError = errMessage(e);
			logDebug('code', 'turn threw', { id: this.id, error: this.lastError });
		} finally {
			this.abortController = null;
			this.clearLive();
			this.ticket = null;
			await this.persist();
			void this.refreshBackground();
		}
	}

	/** Forget everything shown only while a turn runs. */
	private clearLive(): void {
		this.live.clear();
		this.searchSteps = [];
		this.steeringDelivered = [];
	}

	/** Add a finished (or stopped) turn to the thread. */
	private commit(
		result: CodeTurnResult,
		lastCallStats: { durationMs: number; completionTokens: number } | null,
		startedAt: number
	): void {
		const start = this.messages.length;
		this.messages = [...this.messages, ...result.added];
		const last = result.added[result.added.length - 1];
		const answerIndex =
			last && last.role === 'assistant' && !last.tool_calls ? start + result.added.length - 1 : -1;
		if (answerIndex >= 0) {
			if (this.searchSteps.length > 0) {
				this.messageSteps = { ...this.messageSteps, [answerIndex]: this.searchSteps };
			}
			const stats =
				result.outcome === 'complete'
					? computeMessageStats(lastCallStats, Date.now() - startedAt)
					: null;
			if (stats) this.messageStats = { ...this.messageStats, [answerIndex]: stats };
			if (result.outcome === 'complete' && result.stopReason !== 'complete') {
				this.messageStops = { ...this.messageStops, [answerIndex]: result.stopReason };
			}
		}
		if (result.outcome === 'aborted') this.lastError = 'Stopped.';
		if (result.outcome === 'error') {
			this.lastError = result.error ?? 'The turn failed.';
			logDebug('code', 'turn failed', { id: this.id, error: this.lastError });
		}
		// What the model never saw goes back to the user, including anything
		// typed after the loop's last look at the queue.
		const returned = [...result.undeliveredSteering, ...this.steering];
		this.steering = [];
		if (returned.length > 0) this.returnedSteering = returned;
	}

	/**
	 * Write the thread. Per turn, not on shutdown: a power cut runs no
	 * shutdown hook. A failed save is reported, never thrown into the turn.
	 */
	private async persist(): Promise<void> {
		try {
			await saveCodeSession(this.id, encodeCodeSession(this.snapshot()));
			this.saveError = null;
		} catch (e) {
			this.saveError = errMessage(e);
			logDebug('code', 'save failed', { id: this.id, error: this.saveError });
		}
	}

	private scheduleBackgroundPoll(): void {
		if (this.bgTimer !== null) clearTimeout(this.bgTimer);
		this.bgTimer = null;
		if (this.closed || !this.background.some((p) => p.running)) return;
		this.bgTimer = setTimeout(() => {
			this.bgTimer = null;
			void this.refreshBackground();
		}, BG_POLL_MS);
	}
}

function userMessage(body: string, images: string[]): ChatMessage {
	if (images.length === 0) return { role: 'user', content: body };
	return {
		role: 'user',
		content: [
			...(body ? [{ type: 'text' as const, text: body }] : []),
			...images.map((url) => ({ type: 'image_url' as const, image_url: { url } }))
		]
	};
}

// --- registry -------------------------------------------------------------

const sessions = $state<CodeSession[]>([]);
let activeId = $state<string | null>(null);

/** Sessions open as sub-tabs, in tab order. */
export function getOpenSessions(): CodeSession[] {
	return sessions;
}

export function getActiveSessionId(): string | null {
	return activeId;
}

export function getActiveSession(): CodeSession | null {
	return sessions.find((s) => s.id === activeId) ?? null;
}

export function setActiveSession(id: string): void {
	if (sessions.some((s) => s.id === id)) activeId = id;
}

/** Open a saved session (or focus it if already open) and make it active. */
export async function openSession(id: string): Promise<CodeSession> {
	const open = sessions.find((s) => s.id === id);
	if (open) {
		activeId = id;
		return open;
	}
	const record = await loadCodeSession(id);
	// Opened twice at once: the first load wins.
	const raced = sessions.find((s) => s.id === id);
	if (raced) {
		activeId = id;
		return raced;
	}
	return adopt(new CodeSession(record));
}

/** Create a session in `root` and open it. */
export async function newSession(
	root: string,
	opts: { backend?: BackendOverride | null; effort?: string | null } = {}
): Promise<CodeSession> {
	return adopt(new CodeSession(await createCodeSession(root, opts)));
}

/**
 * Close a session's sub-tab: stop its turn (saving what it finished) and its
 * background processes. The saved session stays in the sidebar. The UI asks
 * first when processes are running.
 */
export async function closeSession(id: string): Promise<void> {
	const idx = sessions.findIndex((s) => s.id === id);
	if (idx < 0) return;
	const session = sessions[idx];
	sessions.splice(idx, 1);
	if (activeId === id) activeId = (sessions[idx] ?? sessions[idx - 1] ?? null)?.id ?? null;
	await session.dispose();
	await invoke('code_bg_stop_owner', { owner: id }).catch((e: unknown) => {
		logDebug('code', 'stopping background processes failed', { id, error: errMessage(e) });
	});
}

function adopt(session: CodeSession): CodeSession {
	sessions.push(session);
	activeId = session.id;
	void session.refreshBackground();
	return session;
}
