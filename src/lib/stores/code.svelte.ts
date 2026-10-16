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

import { messageText, type BackendOverride, type ChatMessage, type Usage } from '#lib/api.ts';
import type { AgentsMd } from '#lib/ipc/gen/AgentsMd.ts';
import type { BgProcess } from '#lib/ipc/gen/BgProcess.ts';
import type { SkillDoc } from '#lib/ipc/gen/SkillDoc.ts';
import { withInferenceSlot, type InferenceTicket } from '#lib/agent/inferenceQueue.svelte.ts';
import { resolveBackendDescriptor } from '#lib/inference/descriptor.ts';
import { chooseCut, compactCodeThread } from '#lib/code/compaction.ts';
import type { AgentStopReason, SearchStep, SteeringMessage } from '#lib/agent/loop.ts';
import { markStepDone, markStepProgress } from '#lib/agent/steps.ts';
import { SubtaskStops, subtaskActive, type SubtaskState } from '#lib/code/subtask.ts';
import {
	BackgroundSubtasks,
	buildSubtaskNotification,
	type CompletedSubtask
} from '#lib/code/backgroundSubtasks.ts';
import type { SubtaskSpec } from '#lib/code/subtaskRun.ts';
import { discardSessionSubtaskWorktrees } from '#lib/code/subtaskGit.ts';
import { describeContextManaged } from '#lib/agent/context-budget.ts';
import { computeMessageStats, type MessageStats } from '#lib/stores/chat.svelte.ts';
import {
	approveSession,
	codeApprovalKey,
	isSessionApproved,
	resetSessionApproval
} from '#lib/stores/codeCommandApproval.svelte.ts';
import { renderSlashMessage, typedText } from '#lib/skills/content.ts';
import {
	adoptCodeWatches,
	buildWatchNotification,
	clearCodeWatches,
	consumeWatches,
	peekCompletedCodeWatches,
	setCodeWatchCompletionHandler,
	takeCodeWatches
} from '#lib/shell/backgroundWatch.ts';
import {
	createCodeSession,
	decodeAgentBranch,
	deleteCodeSession,
	folderExists,
	forkCodeSession,
	loadCodeSession,
	saveCodeSession,
	setCodeSessionRoot,
	updateCodeSessionMeta,
	type CodeSessionRecord
} from '#lib/code/db.ts';
import {
	decodeCodeSession,
	encodeCodeSession,
	type CodeCompaction,
	type CodeSessionState
} from '#lib/code/session.ts';
import { runCodeTurn, type CodeTurnResult } from '#lib/code/runCodeTurn.ts';
import type { PendingToolCall } from '#lib/code/pendingCall.ts';
import { LiveTurn } from '#lib/code/liveTurn.svelte.ts';
import { setShellWaitListener, type ShellWait } from '#lib/code/shellBridge.ts';
import { registerCodeOpener } from '#lib/code/bridge.ts';
import { setActiveTab } from '#lib/stores/activeTab.svelte.ts';
import { updateSettings } from '#lib/stores/settings.ts';
import { isUnsetTitle, sessionLabel } from '#lib/code/sessionList.ts';
import { claimSession, raiseWindow, releaseSession } from '#lib/code/claims.ts';
import { forkPoint, type Prefill } from '#lib/code/fork.ts';
import type { CodeForkMode } from '#lib/ipc/gen/CodeForkMode.ts';
import {
	branchNotice,
	branchSeen,
	gitStatus,
	removeWorktree,
	type GitStatus,
	type WorktreeRemoval
} from '#lib/code/git.ts';
import {
	createWriteGuard,
	formatFileNotices,
	releaseFolder,
	takeFileNotices,
	type TurnWriteGuard
} from '#lib/code/folders.ts';
import type { CodeWriteGuard } from '#lib/agent/tools/types.ts';
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
	/**
	 * The project folder. Fixed for the session's life, except that a session
	 * whose folder is gone can be pointed at another (`moveTo`).
	 */
	root = $state('');
	/**
	 * The WSL distro `root` is in (Windows; a Linux path), or null for a
	 * folder on the host. Changes only with `root`, through `moveTo`.
	 */
	wslDistro = $state<string | null>(null);
	/**
	 * May read, not write: a fork that shares its source's folder. Writes
	 * and edits are refused and every command asks first.
	 */
	readonly readOnly: boolean;
	/**
	 * The last message came from another computer (Settings → Remote
	 * control), so turns leave out what needs a person at this one.
	 */
	private remote = false;
	/** The git worktree Haruspex made for this session (a worktree fork). */
	worktree = $state<string | null>(null);
	/**
	 * The folder is gone (deleted, a worktree removed, a drive unmounted).
	 * The session can be read but runs no turns until it is pointed at
	 * another folder or deleted. Set by `checkFolder`, which runs when the
	 * session is opened or activated, on window focus, and as each turn starts
	 * and ends; never while a turn runs.
	 */
	folderMissing = $state(false);
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
	/**
	 * The summary standing in for the older turns (`code/compaction.ts`). The
	 * model is sent it and the messages from its cut; `messages` keeps all.
	 */
	compaction = $state.raw<CodeCompaction | null>(null);
	/** The running turn is summarising older turns before it starts. */
	compacting = $state(false);

	status = $state<CodeSessionStatus>('idle');
	/** The waiting inference ticket while `status` is 'queued'. */
	ticket = $state<InferenceTicket | null>(null);
	/** Messages typed while a turn runs, not yet given to the model. */
	steering = $state<SteeringMessage[]>([]);
	/** Steering the running turn has given the model. Cleared when it ends. */
	steeringDelivered = $state<SteeringMessage[]>([]);
	/**
	 * Steering the turn ended without delivering (stopped, or out of
	 * iterations), for the input box to take back. See `takeReturnedSteering`.
	 */
	returnedSteering = $state<string[]>([]);
	/** Images that went back with `returnedSteering`. */
	returnedImages = $state<string[]>([]);
	/** This session's background processes, from `code_bg_status`. */
	background = $state<BgProcess[]>([]);
	/** The Shell tab an `open_in_shell` call waits on, while `status` is 'waiting-shell'. */
	shellWait = $state.raw<ShellWait | null>(null);
	/**
	 * What the input box should start with (a fork from one of the user's
	 * messages), for the input box to take (`takePrefill`). An empty prefill
	 * still asks for the input to be focused.
	 */
	prefill = $state.raw<Prefill | null>(null);

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
	/** The folder's git state (`refreshGit`); null without git or outside a repo. */
	git = $state.raw<GitStatus | null>(null);
	/**
	 * What other sessions changed in the folder, as told to the model at the
	 * start of a turn. Shown before the message it came with; not saved.
	 */
	fileNotes = $state<{ text: string; at: number }[]>([]);
	/** When this session last looked for other sessions' changes (ms). */
	private noticesSince: number;
	/** The branch the agent was last told or saw; undefined until it's been told. */
	private branchSeenByAgent: string | null | undefined = undefined;
	private abortController: AbortController | null = null;
	/** Stop handles for the session's subtasks (`delegate`), its turn's and background ones. */
	private readonly subtaskStops = new SubtaskStops();
	/** Subtasks that run on after the turn that started them. */
	private readonly backgroundSubtasks: BackgroundSubtasks;
	/** Background subtasks that have ended, waiting to be reported in a turn. */
	private completedSubtasks: CompletedSubtask[] = [];
	/** The running turn's write guard, which a background apply shares. */
	private turnGuard: TurnWriteGuard | null = null;
	/** How many background subtasks are running or waiting to. */
	backgroundSubtaskCount = $state(0);
	/** Reads the input box's unsent text and images (`setDraftReader`). */
	private draftReader: (() => Prefill) | null = null;
	/** Settles once the running turn has been saved. */
	private turnDone: Promise<void> | null = null;
	/** The naming call has been made (or is under way); it is made once. */
	private named = false;
	private closed = false;
	/** A watch notification is being put together. */
	private flushing = false;
	private bgTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly unwatch: () => void;
	private readonly unwatchShell: () => void;

	constructor(record: CodeSessionRecord) {
		this.id = record.id;
		this.root = record.root;
		this.wslDistro = record.wsl_distro ?? null;
		this.readOnly = record.read_only ?? false;
		this.worktree = record.worktree ?? null;
		// What the agent was told by the last saved turn, so a restart
		// neither repeats it nor misses what came since. Before that was
		// kept, the last saved turn stands in.
		this.noticesSince = record.notices_seen_at ?? record.updated_at;
		this.branchSeenByAgent = decodeAgentBranch(record.agent_branch);
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
			this.compaction = thread.compaction ?? null;
		}
		this.unwatch = setCodeWatchCompletionHandler(this.id, () => {
			void this.flushWatchNotifications();
		});
		this.backgroundSubtasks = new BackgroundSubtasks({
			place: () => ({
				sessionId: this.id,
				folder: this.root,
				wslDistro: this.wslDistro,
				backend: this.backend ? ($state.snapshot(this.backend) as BackendOverride) : null,
				effort: this.effort,
				requester: () => `Code · ${sessionLabel({ title: this.title, root: this.root })}`
			}),
			lease: () => this.backgroundLease(),
			stops: this.subtaskStops,
			onState: (state) => this.updateSubtaskCard(state),
			onDone: (done) => {
				this.completedSubtasks = [...this.completedSubtasks, done];
				this.backgroundSubtaskCount = this.backgroundSubtasks.active;
				void this.flushWatchNotifications();
			}
		});
		this.unwatchShell = setShellWaitListener(this.id, (wait) => this.onShellWait(wait));
	}

	/** `open_in_shell` started or stopped waiting on a Shell tab. */
	private onShellWait(wait: ShellWait | null): void {
		this.shellWait = wait;
		if (wait && this.status === 'running') this.status = 'waiting-shell';
		else if (!wait && this.status === 'waiting-shell') this.status = 'running';
	}

	/** Show the Shell tab the turn waits on. */
	goToShell = (): void => {
		this.shellWait?.focus();
	};

	/** Stop waiting on the shell; the turn carries on without the result. */
	cancelShellWait = (): void => {
		this.shellWait?.cancel();
	};

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
	 * given to the model, images and all, at the next step (a skill is not:
	 * it only starts a turn).
	 */
	send = async (
		text: string,
		opts: { images?: string[]; skill?: SkillDoc; remote?: boolean } = {}
	): Promise<void> => {
		const trimmed = text.trim();
		const images = opts.images ?? [];
		if (this.closed || (!trimmed && images.length === 0)) return;
		// Whoever wrote last drives the turns that follow, a watched command's
		// follow-up included.
		this.remote = opts.remote ?? false;
		if (this.busy) {
			this.steering = [...this.steering, { text: trimmed, images }];
			return;
		}
		if (this.folderMissing) {
			this.giveBack(trimmed, images);
			return;
		}
		const body = opts.skill ? renderSlashMessage(opts.skill, trimmed) : trimmed;
		// The first real message names the session, once its turn is over.
		const namesFrom =
			!this.named && !this.title && trimmed && !opts.skill && !isSlashCommand(trimmed)
				? trimmed
				: null;
		if (namesFrom) this.named = true;
		const sent = await this.runTurn(userMessage(body, images), { typed: true });
		if (namesFrom && sent) await this.name(namesFrom);
		else if (namesFrom) this.named = false;
	};

	/** Resume after a turn limit or forced stop. */
	continueTurn = (): Promise<void> => this.send('Please continue from where you stopped.');

	/**
	 * Whether `/compact` has anything to summarise now: some turns past the
	 * current cut that the newest ones, kept whole, leave over.
	 */
	canCompact = (): boolean => {
		const backend = this.backend ? ($state.snapshot(this.backend) as BackendOverride) : null;
		const contextSize = resolveBackendDescriptor(backend ?? undefined).contextSize;
		return chooseCut(this.messages, this.compaction?.at ?? 0, contextSize) !== null;
	};

	/**
	 * `/compact`: summarise the older turns now, without a turn after it.
	 * `instructions` is what the user asked the summary to keep. Runs like a
	 * turn: it queues for the model and Stop cancels it. There is no turn to
	 * take what is typed meanwhile, so that goes back to the input box.
	 */
	compactNow = async (
		instructions = ''
	): Promise<'compacted' | 'nothing' | 'busy' | 'failed' | 'stopped'> => {
		if (this.busy || this.closed) return 'busy';
		this.status = 'running';
		this.lastError = null;
		const abort = new AbortController();
		this.abortController = abort;
		const backend = this.backend ? ($state.snapshot(this.backend) as BackendOverride) : null;
		const contextSize = resolveBackendDescriptor(backend ?? undefined).contextSize;
		try {
			const next = await withInferenceSlot(
				{
					consumer: 'code',
					backend: backend ?? undefined,
					signal: abort.signal,
					onTicket: (t) => {
						this.ticket = t;
						this.status = 'queued';
					},
					onAdmitted: () => {
						this.ticket = null;
						this.status = 'running';
					}
				},
				async () => {
					this.compacting = true;
					try {
						return await compactCodeThread({
							messages: $state.snapshot(this.messages) as ChatMessage[],
							compaction: this.compaction,
							backend,
							contextSize,
							signal: abort.signal,
							instructions
						});
					} finally {
						this.compacting = false;
					}
				}
			);
			if (!next) return 'nothing';
			this.compaction = next;
			this.usage = null;
			this.contextNotice = null;
			await this.persist();
			return 'compacted';
		} catch (e) {
			if (abort.signal.aborted) return 'stopped';
			this.lastError = `Couldn't summarise the older turns: ${errMessage(e)}`;
			logDebug('code', 'compaction failed', { id: this.id, error: errMessage(e) });
			return 'failed';
		} finally {
			this.abortController = null;
			this.ticket = null;
			this.status = 'idle';
			this.handBack(this.steering);
			this.steering = [];
			queueMicrotask(() => void this.flushWatchNotifications());
		}
	};

	/**
	 * Cancel the running turn. What it finished is saved. A turn still
	 * waiting for an inference slot leaves the queue without starting: its
	 * message goes back to the input box (`returnedSteering`,
	 * `returnedImages`) and nothing is saved.
	 */
	stop = (): void => {
		this.abortController?.abort();
		// Background subtasks run on; their cards, and closing the session, stop them.
		this.subtaskStops.stopAll({ background: false });
	};

	/**
	 * Hand a `delegate` call with `background: true` to the session: it runs
	 * on after the turn and reports in a notification turn.
	 */
	private startBackgroundSubtask = (spec: SubtaskSpec, initial: SubtaskState): void => {
		this.backgroundSubtasks.start(spec, initial);
		this.backgroundSubtaskCount = this.backgroundSubtasks.active;
	};

	/**
	 * The write lease for a background subtask's apply: the running turn's,
	 * which it then leaves for the turn to give back, or one of its own.
	 */
	private backgroundLease(): { guard: CodeWriteGuard; done: () => Promise<void> } {
		if (this.turnGuard) return { guard: this.turnGuard, done: async () => {} };
		const own = createWriteGuard({
			sessionId: this.id,
			root: this.root,
			wslDistro: this.wslDistro,
			title: () => this.title
		});
		const changed: string[] = [];
		return {
			guard: {
				acquire: () => own.acquire(),
				changed: (paths) => {
					changed.push(...paths);
					own.changed(paths);
				}
			},
			done: async () => {
				// A turn began meanwhile and holds the same lease: it gives it back.
				if (this.turnGuard) this.turnGuard.changed(changed);
				else await own.finish();
			}
		};
	}

	/**
	 * Put a subtask's card where its step is now: the running turn's steps,
	 * or a saved answer's once the turn that started it has ended.
	 */
	private updateSubtaskCard(state: SubtaskState): void {
		const patch = (steps: SearchStep[]) =>
			steps.map((s) => (s.subtask?.id === state.id ? { ...s, subtask: state } : s));
		if (this.searchSteps.some((s) => s.subtask?.id === state.id)) {
			this.searchSteps = patch(this.searchSteps);
			return;
		}
		for (const [key, steps] of Object.entries(this.messageSteps)) {
			if (!steps.some((s) => s.subtask?.id === state.id)) continue;
			this.messageSteps = { ...this.messageSteps, [key]: patch(steps) };
			// Saved once it ends; a running turn saves it with everything else.
			if (!subtaskActive(state) && !this.busy) void this.persist();
			return;
		}
	}

	/** Stop one of the running turn's subtasks; the turn carries on without it. */
	stopSubtask = (id: string): void => {
		this.subtaskStops.stop(id);
	};

	/** Take the images handed back with an unsent message, clearing them. */
	takeReturnedImages = (): string[] => {
		const images = this.returnedImages;
		this.returnedImages = [];
		return images;
	};

	/**
	 * The input box registers how to read what is typed and not yet sent, so
	 * it can go with the session to another window. Returns the unregister.
	 */
	setDraftReader = (read: () => Prefill): (() => void) => {
		this.draftReader = read;
		return () => {
			if (this.draftReader === read) this.draftReader = null;
		};
	};

	/** The unsent input, or null when the box is empty. */
	readDraft = (): Prefill | null => {
		const d = this.draftReader?.() ?? null;
		if (!d || (!d.text.trim() && d.images.length === 0)) return null;
		return { text: d.text, images: [...d.images] };
	};

	/**
	 * Look at the folder: `folderMissing` when it is gone. Not while a turn
	 * runs (its tools fail as they would anyway); the turn's end looks again.
	 * Resolves to whether the folder is there.
	 */
	checkFolder = async (): Promise<boolean> => {
		if (this.closed || this.busy) return !this.folderMissing;
		const root = this.root;
		const distro = this.wslDistro;
		const ok = await folderExists(root, distro);
		if (!this.closed && !this.busy && this.root === root && this.wslDistro === distro) {
			this.folderMissing = !ok;
		}
		return ok;
	};

	/**
	 * Point the session at another folder, when its own is gone. Only while
	 * idle. The thread is kept; paths in it still name the old folder.
	 * `wslDistro` as `newSession` takes it.
	 */
	moveTo = async (root: string, wslDistro: string | null = null): Promise<void> => {
		if (this.busy) throw new Error('Wait for the turn to finish.');
		const record = await setCodeSessionRoot(this.id, root, wslDistro);
		this.root = record.root;
		this.wslDistro = record.wsl_distro ?? null;
		this.worktree = record.worktree ?? null;
		this.folderMissing = false;
		this.projectRoot = null;
		this.agentsMd = null;
		this.git = null;
		await this.refreshGit();
	};

	/** Take the steering a finished turn handed back, clearing it. */
	takeReturnedSteering = (): string[] => {
		const texts = this.returnedSteering;
		this.returnedSteering = [];
		return texts;
	};

	/** Take the prefill, clearing it. */
	takePrefill = (): Prefill | null => {
		const p = this.prefill;
		this.prefill = null;
		return p;
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

	/** Re-read the folder's branch and changes. */
	refreshGit = async (): Promise<void> => {
		if (this.closed) return;
		const status = await gitStatus(this.root, this.wslDistro);
		if (!this.closed) this.git = status;
	};

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
		if (this.busy || this.closed || this.flushing || this.folderMissing) return;
		const completed = peekCompletedCodeWatches(this.id);
		if (completed.length === 0) {
			await this.flushSubtaskNotifications();
			return;
		}
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

	/**
	 * Deliver finished background subtasks' reports as a turn of their own,
	 * once idle; all that have finished go in one turn. Watched commands go
	 * first, in theirs (`flushWatchNotifications`).
	 */
	private async flushSubtaskNotifications(): Promise<void> {
		if (this.busy || this.closed || this.completedSubtasks.length === 0) return;
		const done = this.completedSubtasks;
		this.completedSubtasks = [];
		await this.runTurn({ role: 'user', content: buildSubtaskNotification(done) });
	}

	/** The thread as `encodeCodeSession` takes it. */
	snapshot = (): CodeSessionState => ({
		messages: $state.snapshot(this.messages) as ChatMessage[],
		messageSteps: $state.snapshot(this.messageSteps) as Record<number, SearchStep[]>,
		messageStats: $state.snapshot(this.messageStats),
		messageStops: $state.snapshot(this.messageStops),
		messageHistorySent: $state.snapshot(this.messageHistorySent),
		compaction: this.compaction
	});

	/**
	 * Stop the turn and let go of everything this session holds in the app.
	 * Resolves once a stopped turn has been saved. Background processes are
	 * the registry's to stop (`closeSession`).
	 */
	dispose = async (): Promise<void> => {
		this.closed = true;
		this.stop();
		this.subtaskStops.stopAll();
		this.unwatch();
		this.unwatchShell();
		clearCodeWatches(this.id);
		resetSessionApproval(codeApprovalKey(this.id));
		if (this.bgTimer !== null) clearTimeout(this.bgTimer);
		this.bgTimer = null;
		await this.turnDone;
		// Stopped writers tidy their worktrees away as they end.
		await this.backgroundSubtasks.settle();
		// The turn gives the folder back as it ends; this covers a turn that
		// never got that far.
		await releaseFolder(this.id);
	};

	/**
	 * Run a turn opening with `opening`. `typed`: the user sent it, so a turn
	 * that never starts (stopped while queued, or the folder gone) hands it
	 * back. Resolves to whether the turn ran.
	 */
	private runTurn(opening: ChatMessage, opts: { typed?: boolean } = {}): Promise<boolean> {
		if (this.busy || this.closed) return Promise.resolve(false);
		this.status = 'running';
		const done = this.turn(opening, opts.typed ?? false).finally(() => {
			this.status = 'idle';
			this.shellWait = null;
			this.turnDone = null;
			// The folder may have gone while the turn ran; say so now.
			void this.checkFolder();
			// A watched command may have finished during the turn; deliver it
			// now that the session is idle, once this turn has fully unwound.
			queueMicrotask(() => void this.flushWatchNotifications());
		});
		this.turnDone = done.then(() => {});
		return done;
	}

	private async turn(opening: ChatMessage, typed: boolean): Promise<boolean> {
		this.lastError = null;
		this.contextNotice = null;
		this.clearLive();
		this.returnedSteering = [];
		this.returnedImages = [];
		const openingAt = this.messages.length;
		this.messages = [...this.messages, opening];

		const abort = new AbortController();
		this.abortController = abort;
		let lastCallStats: { durationMs: number; completionTokens: number } | null = null;
		const startedAt = Date.now();
		const guard = createWriteGuard({
			sessionId: this.id,
			root: this.root,
			wslDistro: this.wslDistro,
			title: () => this.title
		});
		this.turnGuard = guard;
		// What the agent had been told, put back if the turn never starts.
		const told = {
			openingAt,
			since: this.noticesSince,
			branch: this.branchSeenByAgent,
			notes: this.fileNotes
		};
		let admitted = false;
		let started = true;

		try {
			if (!(await folderExists(this.root, this.wslDistro))) {
				this.folderMissing = true;
				started = false;
				return false;
			}
			const notice = await this.takeNotice();
			const result = await runCodeTurn({
				sessionId: this.id,
				root: this.root,
				title: () => this.title,
				thread: $state.snapshot(this.messages) as ChatMessage[],
				compaction: this.compaction,
				lastUsage: this.usage,
				onCompacting: (active) => (this.compacting = active),
				onCompacted: (c) => {
					this.compaction = c;
					// The gauge and any fit notice described the prompt before it.
					this.usage = null;
					this.contextNotice = null;
				},
				backend: this.backend ? ($state.snapshot(this.backend) as BackendOverride) : null,
				effort: this.effort,
				readOnly: this.readOnly,
				remote: this.remote,
				wslDistro: this.wslDistro,
				writeGuard: guard,
				worktree: this.worktree ? { branch: this.git?.branch ?? null } : undefined,
				notice,
				signal: abort.signal,
				takeSteering: () => {
					const steers = this.steering;
					this.steering = [];
					return steers;
				},
				onSteering: (steers) => {
					this.steeringDelivered = [...this.steeringDelivered, ...steers];
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
					admitted = true;
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
				subtaskStops: this.subtaskStops,
				startBackgroundSubtask: this.startBackgroundSubtask,
				onSubtaskUpdate: (call, subtask) => {
					this.searchSteps = this.searchSteps.map((s) =>
						s.id === call.id ? { ...s, subtask } : s
					);
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
			// Stopped before the model was ever asked: the turn never started,
			// and what the user sent goes back to them. (A watch notice keeps
			// its place in the thread, as before.)
			if (typed && result.outcome === 'aborted' && !admitted) started = false;
			else this.commit(result, lastCallStats, startedAt);
		} catch (e) {
			// runCodeTurn reports failures in its result; this is a bug guard.
			this.lastError = errMessage(e);
			logDebug('code', 'turn threw', { id: this.id, error: this.lastError });
		} finally {
			this.abortController = null;
			this.clearLive();
			this.ticket = null;
			this.turnGuard = null;
			await guard.finish();
			if (started) {
				// What the turn itself did to the branch (a `git switch` it ran)
				// is what it saw, so only later changes get a note.
				await this.refreshGit();
				this.branchSeenByAgent = branchSeen(this.git);
				await this.persist();
			} else {
				this.unsend(opening, typed, told);
			}
			void this.refreshBackground();
		}
		return started;
	}

	/**
	 * Take back a turn that never started: its opening message leaves the
	 * thread (nothing is saved) and, when the user typed it, goes back to the
	 * input box with anything queued behind it. What the agent was told for
	 * it is untold.
	 */
	private unsend(
		opening: ChatMessage,
		typed: boolean,
		told: {
			openingAt: number;
			since: number;
			branch: string | null | undefined;
			notes: CodeSession['fileNotes'];
		}
	): void {
		// Nothing was added after it: the turn never reached the model.
		this.messages = this.messages.slice(0, told.openingAt);
		this.noticesSince = told.since;
		this.branchSeenByAgent = told.branch;
		this.fileNotes = told.notes;
		this.lastError = null;
		const queued = this.steering;
		this.steering = [];
		if (!typed) {
			this.handBack(queued);
			return;
		}
		const text = typedText(messageText(opening.content)).trim();
		this.giveBack([text, ...queued.map((m) => m.text)].filter(Boolean).join('\n\n'), [
			...imagesOf(opening),
			...queued.flatMap((m) => m.images ?? [])
		]);
	}

	/** Hand text and images back to the input box. */
	private giveBack(text: string, images: string[]): void {
		if (text) this.returnedSteering = [...this.returnedSteering, text];
		if (images.length) this.returnedImages = [...this.returnedImages, ...images];
	}

	/** Hand steering the model never saw back to the input box. */
	private handBack(steers: SteeringMessage[]): void {
		for (const m of steers) this.giveBack(m.text, m.images ?? []);
	}

	/**
	 * Other sessions' changes to the folder since this one last looked, as
	 * the note this turn opens with; also shown above the opening message.
	 */
	private async takeNotice(): Promise<string | null> {
		const batch = await takeFileNotices(this.id, this.root, this.noticesSince, this.wslDistro);
		this.noticesSince = batch.now;
		const files = formatFileNotices(batch.notices, this.root);
		// The branch can change under the agent between turns (the branch menu,
		// the Shell, another terminal); without this it answers from memory.
		await this.refreshGit();
		const now = branchSeen(this.git);
		const branch = branchNotice(this.branchSeenByAgent, now);
		// Telling a fresh agent the branch is for it alone; a switch is news to
		// the user reading the transcript too.
		const shown = this.branchSeenByAgent === undefined ? null : branch;
		this.branchSeenByAgent = now;
		const display = [shown, files].filter(Boolean).join('\n');
		if (display)
			this.fileNotes = [...this.fileNotes, { text: display, at: this.messages.length - 1 }];
		return [branch, files].filter(Boolean).join('\n') || null;
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
		this.handBack([...result.undeliveredSteering, ...this.steering]);
		this.steering = [];
	}

	/**
	 * Write the thread. Per turn, not on shutdown: a power cut runs no
	 * shutdown hook. A failed save is reported, never thrown into the turn.
	 */
	private async persist(): Promise<void> {
		try {
			await saveCodeSession(this.id, encodeCodeSession(this.snapshot()), undefined, {
				noticesSeenAt: this.noticesSince,
				agentBranch: this.branchSeenByAgent
			});
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

function imagesOf(m: ChatMessage): string[] {
	if (typeof m.content === 'string') return [];
	return m.content.flatMap((p) => (p.type === 'image_url' ? [p.image_url.url] : []));
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
	const session = sessions.find((s) => s.id === id);
	if (!session) return;
	activeId = id;
	void session.checkFolder();
}

/**
 * Open a saved session (or focus it if already open) and make it active.
 *
 * A session is open in one window at a time: when another window has it,
 * that window is brought to the front instead and this returns null.
 */
export async function openSession(id: string): Promise<CodeSession | null> {
	const open = sessions.find((s) => s.id === id);
	if (open) {
		setActiveSession(id);
		return open;
	}
	const claim = await claimSession(id);
	if (claim.owner) {
		await raiseWindow(claim.owner);
		return null;
	}
	// Opened twice at once: the first load wins.
	const raced = sessions.find((s) => s.id === id);
	if (raced) {
		activeId = id;
		return raced;
	}
	let record: CodeSessionRecord;
	try {
		record = await loadCodeSession(id);
	} catch (e) {
		// Not ours after all; keep what the last window handed over.
		await releaseSession(id, claim.handoff).catch(() => {});
		throw e;
	}
	const again = sessions.find((s) => s.id === id);
	if (again) {
		activeId = id;
		return again;
	}
	// Watches the last window followed come here, and anything that finished
	// meanwhile is delivered once the session is set up.
	if (claim.handoff) adoptCodeWatches(claim.handoff.watches);
	// "Allow for this session" moves with the session (9b).
	if (claim.handoff?.approved) approveSession(codeApprovalKey(id));
	const session = adopt(new CodeSession(record));
	// What was typed in the last window and not sent comes along.
	if (claim.handoff?.draft) session.prefill = claim.handoff.draft;
	if (claim.handoff?.watches.length) void session.flushWatchNotifications();
	return session;
}

/** Create a session in `root` and open it. */
export async function newSession(
	root: string,
	opts: {
		backend?: BackendOverride | null;
		effort?: string | null;
		/** On Windows, the distro a Linux `root` is in. */
		wslDistro?: string | null;
		/** Work in a new git worktree of `root`'s repository. */
		worktree?: boolean;
	} = {}
): Promise<CodeSession> {
	const record = await createCodeSession(root, opts);
	await claimSession(record.id);
	return adopt(new CodeSession(record));
}

/**
 * Fork session `id` at the message at `index` into a new saved session (see
 * `forkPoint`), without opening it. Background processes are not forked.
 * Only an idle session forks: the saved thread is then the one on screen.
 */
export async function forkSession(
	id: string,
	index: number,
	mode: CodeForkMode = 'readOnly'
): Promise<{ id: string; prefill: Prefill }> {
	const source = sessions.find((s) => s.id === id);
	if (!source) throw new Error('That session is not open here.');
	if (source.busy) throw new Error('Wait for the turn to finish, then fork.');
	const point = forkPoint(source.messages, index);
	if (!point) throw new Error('Only your messages and answers can be forked from.');
	const record = await forkCodeSession(id, point.at, mode);
	return { id: record.id, prefill: point.prefill ?? { text: '', images: [] } };
}

/** Fork and open the fork here as a sub-tab, its input box filled and focused. */
export async function forkAndOpen(
	id: string,
	index: number,
	mode: CodeForkMode = 'readOnly'
): Promise<CodeSession | null> {
	const fork = await forkSession(id, index, mode);
	const session = await openSession(fork.id);
	if (session) session.prefill = fork.prefill;
	return session;
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
	await releaseSession(id).catch((e: unknown) => {
		logDebug('code', 'releasing the session failed', { id, error: errMessage(e) });
	});
}

/**
 * Let another window have a session: close its sub-tab here without stopping
 * its background processes, and hand their watches to whichever window opens
 * it next. Only an idle session moves (a turn can't cross windows); returns
 * false, and does nothing, otherwise.
 */
export async function handOffSession(id: string): Promise<boolean> {
	const idx = sessions.findIndex((s) => s.id === id);
	if (idx < 0) return false;
	const session = sessions[idx];
	// Background subtasks run in this window, so they can't move with it.
	if (session.busy || session.backgroundSubtaskCount > 0) return false;
	// Read before the sub-tab goes, while the input box is still there.
	const draft = session.readDraft();
	sessions.splice(idx, 1);
	if (activeId === id) activeId = (sessions[idx] ?? sessions[idx - 1] ?? null)?.id ?? null;
	const watches = takeCodeWatches(id);
	// Read before dispose, which resets it.
	const approved = isSessionApproved(codeApprovalKey(id));
	await session.dispose();
	await releaseSession(id, { watches, draft, ...(approved ? { approved } : {}) });
	return true;
}

/**
 * Delete a saved session. Refused (false) while another window has it open:
 * that window is brought to the front instead. With `removeWorktree`, the
 * worktree at that path goes too when it is clean; `worktree` says what
 * happened to it.
 */
export async function deleteSession(
	id: string,
	opts: {
		removeWorktree?: string | null;
		/** The WSL distro the worktree is in; its git removes it. */
		wslDistro?: string | null;
	} = {}
): Promise<false | { worktree: WorktreeRemoval | null }> {
	const claim = await claimSession(id);
	if (claim.owner) {
		await raiseWindow(claim.owner);
		return false;
	}
	// Where its subtasks' kept copies are: read before the record goes.
	const place = await loadCodeSession(id).catch(() => null);
	await closeSession(id);
	// Processes a hand-off left running with no window to open them.
	await invoke('code_bg_stop_owner', { owner: id }).catch(() => {});
	if (place) {
		await discardSessionSubtaskWorktrees(place.root, id, place.wsl_distro ?? null).catch((e) =>
			logDebug('code', 'removing subtask worktrees failed', { id, error: errMessage(e) })
		);
	}
	try {
		await deleteCodeSession(id);
	} finally {
		await releaseSession(id).catch(() => {});
	}
	if (!opts.removeWorktree) return { worktree: null };
	try {
		return { worktree: await removeWorktree(opts.removeWorktree, opts.wslDistro ?? null) };
	} catch (e) {
		return { worktree: { kind: 'kept', reason: errMessage(e) } };
	}
}

function adopt(session: CodeSession): CodeSession {
	sessions.push(session);
	activeId = session.id;
	void session.refreshBackground();
	void session.refreshGit();
	void session.checkFolder();
	return session;
}

/**
 * The Shell's "Open in Code": a new session at the shell's folder, as a
 * sub-tab, with the Code tab shown. The folder becomes the last one used, as
 * if picked in the new-session dialog.
 */
export async function openCodeSessionAt(
	root: string,
	wslDistro: string | null = null
): Promise<CodeSession> {
	const session = await newSession(root, { wslDistro });
	updateSettings({ codeLastRoot: root, codeLastWslDistro: session.wslDistro ?? '' });
	setActiveTab('code');
	return session;
}

registerCodeOpener(async (root, wslDistro) => {
	await openCodeSessionAt(root, wslDistro ?? null);
});
