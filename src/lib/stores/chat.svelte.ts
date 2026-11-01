import { prepareTurnSkills, skillsPromptSection } from '#lib/skills/turn.ts';
import { renderSlashMessage, typedText } from '#lib/skills/content.ts';
import type { SkillDoc } from '#lib/ipc/gen/SkillDoc.ts';
import {
	type ChatMessage,
	type Usage,
	ApiError,
	messageText,
	mergeLeadingSystemMessages,
	unansweredNotice,
	withNotice
} from '#lib/api.ts';
import {
	runAgentLoop,
	type SearchStep,
	type AgentLoopOptions,
	type AgentStopReason
} from '#lib/agent/loop.ts';
import {
	resolveTurnTools,
	type TurnTools,
	type TurnToolsInput
} from '#lib/agent/loop/turnTools.ts';
import type { DeferredFamily } from '#lib/agent/tools/types.ts';
import { withInferenceSlot } from '#lib/agent/inferenceQueue.svelte.ts';
import { markStepDone, markStepProgress, newRunningStep } from '#lib/agent/steps.ts';
import {
	shouldCompact,
	compactConversation,
	remapIndexedRecords,
	chatModelView,
	SUMMARY_PREFIX
} from '#lib/agent/compaction.ts';
import {
	estimateMessagesTokens,
	estimateTokens,
	describeContextManaged,
	getTokenCalibration
} from '#lib/agent/contextBudget.ts';
import {
	buildSystemPrompt,
	looksLikeFileOutputRequest,
	injectMessageHints
} from '#lib/agent/systemPrompt.ts';
import { diagnoseEmptyResponse } from '#lib/agent/diagnostics.ts';
import { beginTurn, logDebug } from '#lib/debugLog.ts';
import { urlForReport } from '#lib/utils/http.ts';
import { noteConversationLeft, noteTurnFinished } from '#lib/agent/memory/scheduler.ts';
import {
	MEMORY_RECALL_STEP,
	recallForTurn,
	renderMemorySection,
	type RecalledMemory
} from '#lib/agent/memory/recall.ts';
import { rehydrateImages, resolveReplyImages, sweepImages } from '#lib/images/resolve.svelte.ts';
import { placeGeneratedImages } from '#lib/images/eligible.ts';
import { placeGeneratedAudio } from '#lib/audio/eligible.ts';
import { rehydrateAudio } from '#lib/audio/rehydrate.ts';
import {
	chatTurnMaxIterations,
	getSettings,
	updateSettings,
	SETTINGS_KEY
} from '#lib/stores/settings.ts';
import { resolveBackendDescriptor } from '#lib/inference/descriptor.ts';
import {
	getActiveConversationId,
	setActiveConversationId,
	getWorkingDir,
	getWorkingDirFor,
	getDefaultWorkingDir,
	setDefaultWorkingDirState,
	setWorkingDirState,
	forgetWorkingDir,
	clearWorkingDirs
} from '#lib/stores/session.svelte.ts';
// Re-export the read accessors so existing importers of the chat store keep
// working; the backing state now lives in the session leaf store.
export { getActiveConversationId, getWorkingDir, getWorkingDirFor };
import {
	approveChatSandbox,
	forgetChatSandboxApproval
} from '#lib/stores/sandboxApproval.svelte.ts';
import { processCitations, renderMarkdown, stripToolCallArtifacts } from '#lib/markdown.ts';
import { appendStreamDelta, createThinkStreamState } from '#lib/agent/thinkStream.ts';
import { isFetchFailureResult } from '#lib/agent/tools/_helpers.ts';
import { errMessage, isAbortError } from '#lib/utils/error.ts';
import { formatSandboxResult } from '#lib/sandbox/formatResult.ts';
import {
	runPython,
	installPackage,
	resetSandbox,
	hasLiveWorkerFor,
	cancelRun
} from '#lib/sandbox/sandbox.ts';
import {
	updateContextUsage,
	resetContextUsage,
	setContextUsage
} from '#lib/stores/context.svelte.ts';
import { ChatRun } from '#lib/stores/chatRun.svelte.ts';
import { SvelteMap } from 'svelte/reactivity';
import { getServerState } from '#lib/stores/llamaServer.svelte.ts';
import { showToast } from '#lib/stores/toasts.svelte.ts';
import { setChatTaskHandler, takeNotices } from '#lib/tasks/notices.ts';
import type { BackgroundTask } from '#lib/tasks/types.ts';
import { hasPendingNotices, initTasks, ownersWithNotices } from '#lib/tasks/store.svelte.ts';
import {
	initDb,
	dbSaveMessage,
	dbCreateConversation,
	dbRenameConversation,
	dbDeleteConversation,
	dbClearAll,
	dbLoadMessages,
	dbLoadMessageSteps,
	dbReplaceMessages,
	dbGetConversationMemoryEnabled,
	dbSetConversationMemoryEnabled,
	dbSetUnread,
	dbSetWorkingDir,
	dbAdoptWorkingDir,
	type DbConversationSummary
} from '#lib/stores/db.ts';
import { setSandboxRunControls } from '#lib/sandbox/runControls.ts';

export interface Conversation {
	id: string;
	title: string;
	messages: ChatMessage[];
	createdAt: number;
	updatedAt: number;
	contextUsage: { promptTokens: number; completionTokens: number } | null;
	/** Search steps from the last generation in this conversation. Not persisted to DB. */
	searchSteps: SearchStep[];
	/**
	 * Completed search steps from past turns, indexed by the position of the
	 * assistant message they belong to in `messages`. Lets the UI keep
	 * rendering rich artifacts (plots, tables) under the message that
	 * produced them after the live `searchSteps` is cleared at the start
	 * of the next turn. In-memory only — not persisted to DB, so plots
	 * vanish on app restart or chat reload (acceptable for v1).
	 */
	messageSteps: Record<number, SearchStep[]>;
	/**
	 * Per-assistant-message generation stats (tok/s, completion tokens,
	 * wall-clock duration of the visible stream), keyed by the position
	 * of the assistant message in `messages`. In-memory only — vanishes
	 * on app restart or chat reload.
	 */
	messageStats: Record<number, MessageStats>;
	/**
	 * Per-assistant-message stop reason when the SYSTEM forced the turn to end
	 * (hit the turn-count cap, or broke on degraded output), keyed by the
	 * assistant message's position in `messages`. Drives the "stopped at turn
	 * limit / interrupted — Continue" indicator. Absent means the model ended
	 * the turn on its own. In-memory only (vanishes on reload), like messageStats.
	 */
	messageStops: Record<number, AgentStopReason>;
	/** Cited source URLs from the last generation. Not persisted to DB. */
	sourceUrls: string[];
	/**
	 * True while we're rebuilding the chat's Python sandbox state by
	 * replaying its prior install_package / run_python / reset_python
	 * tool calls against a fresh worker. Drives a small "Restoring
	 * Python session…" indicator in the input area.
	 */
	isRestoringSession: boolean;
	/**
	 * Set when a chat had too many prior code calls to replay (>50)
	 * and we skipped restoration. Future code runs in this chat will
	 * start with a fresh sandbox; whatever variables/imports the model
	 * had are gone.
	 */
	sessionRestoreSkipped: boolean;
	/**
	 * Tool-call + tool-result messages from the most recent completed turn.
	 * Optionally spliced back into the next turn's prompt when the
	 * `keepRecentToolResults` setting is enabled, so followup questions can
	 * reference raw research details. In-memory only — not persisted to DB.
	 */
	lastTurnTools?: ChatMessage[];
	/**
	 * Whether this chat participates in cross-chat memory. False is
	 * incognito: no recall in, no recording out, from the moment it is
	 * switched — turns extracted before that stay memories, which is what the
	 * manager is for.
	 *
	 * Undefined until loaded from the DB (the column is the source of truth,
	 * so it survives restart by construction). The gates treat undefined as
	 * "not yet known" and re-read; only an explicit false means incognito.
	 */
	memoryEnabled?: boolean;
	/**
	 * True for a conversation the remote web chat created. Those are never
	 * remembered and the toggle is not offered — a guest must not be able to
	 * seed the owner's memory. Set where the sidebar learns about them, not
	 * by sniffing the id.
	 */
	isRemote?: boolean;
	/**
	 * A turn finished here while another conversation was open, and the user
	 * hasn't looked yet. Persisted, so it survives a restart.
	 */
	unread: boolean;
}

export interface MessageStats {
	tokensPerSecond: number;
	completionTokens: number;
	/** Duration of the FINAL model call — the one tok/s is measured over. */
	durationMs: number;
	/**
	 * Wall-clock time for the whole turn: from the user pressing send to the
	 * answer being committed. Deliberately not `durationMs`, which covers only
	 * the last model call — a turn that ran tools, or that burned a call on
	 * reasoning before answering, spends most of its time outside that call,
	 * and reporting the call as "elapsed" would understate it badly.
	 */
	elapsedMs?: number;
}

/**
 * Turn one LLM call's timing into the per-message stats shown in the thread
 * footer. Shared by the chat store and the shell session so both tabs compute
 * the rate identically. Returns null when the call lacks usable timing (no
 * completion tokens or zero duration).
 *
 * `elapsedMs` is the caller's whole-turn wall clock, passed separately because
 * only the caller knows when the turn began.
 */
export function computeMessageStats(
	s: { durationMs: number; completionTokens: number } | null,
	elapsedMs?: number
): MessageStats | null {
	if (!s || s.completionTokens <= 0 || s.durationMs <= 0) return null;
	return {
		tokensPerSecond: s.completionTokens / (s.durationMs / 1000),
		completionTokens: s.completionTokens,
		durationMs: s.durationMs,
		...(typeof elapsedMs === 'number' && elapsedMs > 0 ? { elapsedMs } : {})
	};
}

// The one folder every chat used before each had its own. Only chats saved
// then, which have no folder stored, take it; nothing writes it now.
const WORKING_DIR_KEY = 'haruspex-working-dir';

function loadSharedWorkingDir(): string | null {
	try {
		const raw = localStorage.getItem(WORKING_DIR_KEY);
		if (raw !== null) return raw || null;
		// The settings field it replaced.
		const legacy = localStorage.getItem(SETTINGS_KEY);
		if (legacy) {
			const parsed = JSON.parse(legacy);
			if (typeof parsed.defaultWorkingDir === 'string' && parsed.defaultWorkingDir) {
				return parsed.defaultWorkingDir;
			}
		}
	} catch {
		// ignore
	}
	return null;
}

let conversations = $state<Conversation[]>([]);
// activeConversationId + the working dirs live in the session leaf store (see
// the import at the top of this file) so the sandbox/worker layer can read
// them without importing this module and forming a cycle.
// Each conversation's turn state, made the first time it sends. A
// conversation with none is idle.
const runs = new SvelteMap<string, ChatRun>();
// What the getters report for a conversation with no run. Never written.
const IDLE = new ChatRun();
// The composer's toggle, for the next send from the open conversation.
let exhaustiveResearch = $state(false);

function runFor(id: string): ChatRun {
	let run = runs.get(id);
	if (!run) {
		run = new ChatRun();
		runs.set(id, run);
	}
	return run;
}

/** The open conversation's run, for the getters. Reading never creates one. */
function activeRun(): ChatRun {
	const id = getActiveConversationId();
	return (id && runs.get(id)) || IDLE;
}

/** A conversation's turn state, or an idle one. Read-only for callers. */
export function getRun(id: string): ChatRun {
	return runs.get(id) ?? IDLE;
}

/** The open conversation's turn state, or an idle one. */
export function getActiveRun(): ChatRun {
	return activeRun();
}

/** Take a queued steering message back before the model sees it. */
export function dropSteering(index: number): void {
	const run = activeRun();
	if (run === IDLE) return;
	run.steering = run.steering.filter((_, k) => k !== index);
}

function generateId(): string {
	return crypto.randomUUID();
}

function generateTitle(content: string): string {
	return content.slice(0, 50).replace(/\n/g, ' ').trim() || 'New chat';
}

// Public API

export async function initChatStore(): Promise<void> {
	const db = await initDb();

	// A chat saved before each had its own folder keeps the one they shared.
	const shared = loadSharedWorkingDir();
	for (const s of db.summaries) {
		setWorkingDirState(s.id, s.working_dir === null ? shared : s.working_dir || null);
	}
	if (db.summaries.some((s) => s.working_dir === null)) void dbAdoptWorkingDir(shared);

	conversations = db.summaries.map((s: DbConversationSummary) => ({
		id: s.id,
		title: s.title,
		messages: [],
		createdAt: s.created_at,
		updatedAt: s.updated_at,
		contextUsage: null,
		searchSteps: [],
		messageSteps: {},
		messageStats: {},
		messageStops: {},
		sourceUrls: [],
		isRestoringSession: false,
		sessionRestoreSkipped: false,
		unread: s.unread
	}));

	if (conversations.length > 0) {
		setActiveConversationId(conversations[0].id);
		await loadConversationMessages(conversations[0].id);
	}
	setChatTaskHandler(onTaskEnded);
	// Notices left from before a reload or a restart.
	void initTasks().then(() => {
		for (const owner of ownersWithNotices('chat:')) void deliverNotices(owner.slice(5));
	});
}

/** The toast for a task that finished in a conversation that isn't open. */
export function noticeToast(title: string, label?: string): string {
	return label ? `“${label}” finished in “${title}”.` : `A task finished in “${title}”.`;
}

/**
 * A task started from a chat ended. Its conversation gets the notice as a
 * follow-up turn as soon as it is idle, open or not; one that isn't open
 * also says so in a toast, with a way to go there.
 */
function onTaskEnded(owner: string, task?: BackgroundTask): void {
	const id = owner.slice('chat:'.length);
	const conv = conversations.find((c) => c.id === id);
	if (!conv) return;
	if (id !== getActiveConversationId()) {
		showToast(noticeToast(conv.title, task?.label), {
			actionLabel: 'Open',
			onAction: () => void setActiveConversation(id)
		});
	}
	void deliverNotices(id);
}

/**
 * Run a conversation's waiting task notices as a turn there, if it is idle.
 * A turn the user starts while they are taken gets them as steering.
 */
async function deliverNotices(id: string): Promise<void> {
	const owner = `chat:${id}`;
	if (getRun(id).busy || !hasPendingNotices(owner)) return;
	if (!conversations.some((c) => c.id === id)) return;
	const notice = await takeNotices(owner);
	if (notice.text) await sendMessageTo(id, notice.text, notice.images);
}

async function loadConversationMessages(id: string): Promise<void> {
	const conv = conversations.find((c) => c.id === id);
	if (!conv) return;
	// Read even when the messages are already in memory: the incognito flag
	// lives in the DB (so it survives restart), and this is where a
	// conversation opened after startup learns its own state.
	void refreshMemoryFlag(conv);
	if (conv.messages.length > 0) return;
	conv.messages = await dbLoadMessages(id);
	// Rehydrate per-message artifacts (images / DataFrames / interactive
	// plots) so inline content survives restart.
	const steps = await dbLoadMessageSteps(id);
	conv.messageSteps = steps as typeof conv.messageSteps;

	// Repopulate chat images from the cache. Lookup only — never a fetch — so
	// opening an old chat makes no network requests at all; an image the cache
	// has evicted simply stops rendering.
	//
	// This lives here, and not in setActiveConversation, because startup
	// restores the first conversation by calling this function directly. Doing
	// it in the caller meant the conversation you land on after a restart —
	// the only one most people look at — was the single one that never
	// rehydrated.
	void rehydrateImages(
		id,
		conv.messages.map((m) => messageText(m.content)),
		// Strip images are referenced nowhere in the message text, so their
		// URLs have to come back from the archived steps.
		conv.messages.map((_m, i) => conv.messageSteps[i] ?? []),
		() => getActiveConversationId() === id
	);
	// Generated audio: relinked by hash so the cache's sweep keeps it.
	void rehydrateAudio(
		id,
		conv.messages.map((m) => messageText(m.content))
	);
}

async function refreshMemoryFlag(conv: Conversation): Promise<void> {
	if (conv.memoryEnabled !== undefined) return;
	conv.memoryEnabled = await dbGetConversationMemoryEnabled(conv.id);
}

/**
 * Flip this chat's incognito state, persisting it.
 *
 * From here forward only: turns already extracted stay memories, because
 * un-remembering them is the manager's job and pretending otherwise would be
 * a privacy promise this cannot keep.
 */
export async function setConversationMemoryEnabled(
	conversationId: string,
	enabled: boolean
): Promise<void> {
	const conv = conversations.find((c) => c.id === conversationId);
	if (!conv || conv.isRemote) return;
	conv.memoryEnabled = enabled;
	await dbSetConversationMemoryEnabled(conversationId, enabled);
}

/** Whether the active chat is participating in memory. Unknown reads as on. */
export function isActiveConversationRemembered(): boolean {
	const conv = getActiveConversation();
	return conv ? conv.memoryEnabled !== false : true;
}

/** Whether the active chat is a remote guest thread (never remembered). */
export function isActiveConversationRemote(): boolean {
	return getActiveConversation()?.isRemote === true;
}

/**
 * Put a conversation created outside this store into the sidebar.
 *
 * Remote chat sessions are real conversation rows, but they are created by the
 * remote driver rather than by `createConversation()` here — so without this
 * they would not appear until the next launch, and the host would have no idea
 * a guest was talking to their machine. Idempotent: a session that keeps
 * chatting calls this on every turn.
 */
export function noteExternalConversation(id: string, title: string): void {
	if (conversations.some((c) => c.id === id)) return;
	// A guest never gets the host's files.
	setWorkingDirState(id, null);
	void dbSetWorkingDir(id, null);
	const now = Date.now();
	conversations = [
		{
			id,
			title,
			// Guest threads are never remembered, and the owner is not offered
			// a switch for it — see the remote driver, which sets the column.
			isRemote: true,
			memoryEnabled: false,
			// Left empty: opening it loads the messages from the database, the
			// same as any conversation restored at startup.
			messages: [],
			createdAt: now,
			updatedAt: now,
			contextUsage: null,
			searchSteps: [],
			messageSteps: {},
			messageStats: {},
			messageStops: {},
			sourceUrls: [],
			isRestoringSession: false,
			sessionRestoreSkipped: false,
			unread: false
		},
		...conversations
	];
}

export function getConversations(): Conversation[] {
	return conversations;
}

export function getActiveConversation(): Conversation | undefined {
	return conversations.find((c) => c.id === getActiveConversationId());
}

/**
 * Set a conversation's folder (the open one's by default). With no chat open,
 * it is the folder the next new chat starts in. Settings → Chat's default is
 * left alone.
 */
export function setWorkingDir(path: string | null, id = getActiveConversationId()): void {
	if (!id) {
		setDefaultWorkingDirState(path);
		return;
	}
	const previous = getWorkingDirFor(id);
	setWorkingDirState(id, path);
	void dbSetWorkingDir(id, path);
	// Switching to a different workdir means the worker's MEMFS + the
	// manager's syncedFiles cache are pinned to the OLD workdir's
	// absolute paths. Leaving them in place leaks ghost files and means
	// Python's cwd doesn't follow the change. Respawning forces the next
	// run_python to do a fresh sync against the new workdir.
	if (previous !== path) void resetSandbox(id);
}

/** Set Settings → Chat's default folder: the one each new chat starts in. */
export function setDefaultWorkingDir(path: string | null): void {
	updateSettings({ chatDefaultWorkingDir: path ?? '' });
	setDefaultWorkingDirState(undefined);
}

// The getters below report the open conversation's run.

export function getIsGenerating(): boolean {
	return activeRun().generating;
}

export function getIsWaitingForSlot(): boolean {
	return activeRun().waitingForSlot;
}

export function getStreamingContent(): string {
	return activeRun().streamingContent;
}

export function getErrorMessage(): string | null {
	return activeRun().errorMessage;
}

export function getErrorTurnId(): number | null {
	return activeRun().errorTurnId;
}

export function getLastTurnFailed(): boolean {
	return activeRun().lastTurnFailed;
}

export function getQueuedForStartup(): boolean {
	return activeRun().queuedForStartup;
}

export function getSearchSteps(): SearchStep[] {
	return getActiveConversation()?.searchSteps ?? [];
}

export function getSourceUrls(): string[] {
	const conv = getActiveConversation();
	if (!conv) return [];
	const run = activeRun();
	if (run.generating && run.streamingContent) {
		const fetched = extractUrlsFromSteps(conv.searchSteps);
		const { citedUrls } = processCitations(run.streamingContent, fetched);
		return citedUrls;
	}
	return conv.sourceUrls;
}

export function renderStreamingHtml(text: string): string {
	if (!text) return '';
	const conv = getActiveConversation();
	const fetched = extractUrlsFromSteps(conv?.searchSteps ?? []);
	const { content } = processCitations(text, fetched);
	return renderMarkdown(content);
}

export function getIsCompacting(): boolean {
	return activeRun().compacting;
}

export function getContextNotice(): string | null {
	return activeRun().contextNotice;
}

export function getExhaustiveResearch(): boolean {
	return exhaustiveResearch;
}

/**
 * Re-run a prior `run_python` step in the active conversation, replacing
 * its tool-result in place. Used by the "Run again" button on errored /
 * timed-out steps. Reads the original code from `step.args.code`; the
 * step's previous artifacts are discarded. No model turn is triggered —
 * the model just sees the updated tool result on its next read.
 */
export async function rerunSandboxStep(stepId: string): Promise<void> {
	const conv = getActiveConversation();
	if (!conv) return;
	const step = conv.searchSteps.find((s) => s.id === stepId);
	if (!step || step.toolName !== 'run_python') return;
	const code = step.args?.code;
	if (typeof code !== 'string' || !code.trim()) return;
	// This path runs Python directly (not via executeTool), so it has to
	// honor the sandbox master switch itself — otherwise "Run again" would
	// execute code after the user has disabled the sandbox in Settings.
	if (!getSettings().sandboxEnabled) {
		conv.searchSteps = conv.searchSteps.map((s) =>
			s.id === stepId
				? {
						...s,
						result: 'Python sandbox is disabled. Enable it in Settings → Chat to run code.'
					}
				: s
		);
		return;
	}
	// Flip to running; clear prior result/artifacts so the UI shows the
	// spinner immediately.
	conv.searchSteps = conv.searchSteps.map((s) =>
		s.id === stepId ? { ...s, status: 'running' as const, result: undefined, artifacts: [] } : s
	);
	try {
		const timeoutMs = Math.round((getSettings().sandboxTimeoutSeconds ?? 60) * 1000);
		const r = await runPython(conv.id, code, { timeoutMs });
		const formatted = formatSandboxResult(r);
		conv.searchSteps = conv.searchSteps.map((s) =>
			s.id === stepId
				? {
						...s,
						status: 'done' as const,
						result: formatted,
						artifacts: r.artifactsList
					}
				: s
		);
	} catch (e) {
		const msg = errMessage(e);
		conv.searchSteps = conv.searchSteps.map((s) =>
			s.id === stepId
				? { ...s, status: 'done' as const, result: `Error: ${msg}`, artifacts: [] }
				: s
		);
	}
}

/**
 * Cancel the active chat's in-flight run_python (terminates its Worker
 * via the WorkerPool). The pending dispatch rejects, the tool's
 * execute() catches it and surfaces a 'Sandbox error: sandbox reset'
 * tool result, the agent loop continues with that result, the UI
 * shows the Run-again button.
 */
export function cancelActiveSandboxRun(): void {
	const id = getActiveConversationId();
	if (id) cancelRun(id);
}

// The sandbox step's buttons reach these through runControls.ts.
setSandboxRunControls({
	rerun: (stepId) => void rerunSandboxStep(stepId),
	cancel: cancelActiveSandboxRun
});

export function setExhaustiveResearch(value: boolean): void {
	exhaustiveResearch = value;
}

/**
 * A Chat turn's tools, decided before its prompt: the prompt lists the
 * families the loop defers, and the loop gets the same split.
 */
function chatTurnTools(
	conversation: Conversation,
	workingDir: string | null,
	skills: TurnToolsInput['skills'],
	deepResearch: boolean
): TurnTools {
	return resolveTurnTools({
		messages: conversation.messages,
		workingDir,
		deepResearch,
		// As the loop gets it: Chat talks to the Settings backend.
		visionSupported: resolveBackendDescriptor().vision,
		interactive: true,
		conversationId: conversation.id,
		skills
	});
}

/** `pending`: the message about to be sent, not yet in the conversation. */
async function compactIfNeeded(
	conversation: Conversation,
	run: ChatRun,
	pending: string
): Promise<void> {
	// What the model is sent: from the latest summary on. Everything before
	// it stays in the chat for the reader, already summarised.
	const view = chatModelView(conversation.messages);
	if (view.length < 10) return;

	// Proactive: estimate the prompt we're *about* to send, the new message
	// included, so a turn that jumps over the wall in one step still
	// compacts first. Scale by the learned calibration so dense content
	// (code/logs) triggers the summary as early as it should.
	const descriptor = resolveBackendDescriptor();
	const calibration = getTokenCalibration(descriptor.calibrationKey);
	const pendingTokens = estimateTokens(pending) * calibration;
	const estimated = estimateMessagesTokens(view) * calibration + pendingTokens;
	// The server's own count for the last request, when there is one. The
	// estimate alone ran 1.8x low on dense text (#536), so the context guard
	// dropped turns before any summary was made. Cleared on compaction.
	const usage = conversation.contextUsage;
	const known = usage ? usage.promptTokens + usage.completionTokens + pendingTokens : 0;
	if (!shouldCompact(Math.max(estimated, known), descriptor.contextSize)) return;

	run.compacting = true;
	try {
		// Summarising is a model call like any other, so it queues for the
		// same inference slot: otherwise it runs straight past a job or
		// memory pass that holds the local server's only stream.
		let summary: string;
		let removedCount: number;
		try {
			({ summary, removedCount } = await withInferenceSlot({ consumer: 'chat' }, () =>
				compactConversation(view)
			));
		} catch (e) {
			// The send goes on without a summary: the pre-send context fit
			// still keeps the prompt inside the window. Throwing here failed the
			// message the user had just typed.
			logDebug('chat', 'compaction failed', { error: errMessage(e) });
			return;
		}
		if (!summary || removedCount === 0) return;

		const remaining = view.filter((m) => m.role === 'user' || m.role === 'assistant');
		const kept = remaining.slice(remaining.length - 8);
		const summaryMsg: ChatMessage = {
			role: 'system',
			content: `${SUMMARY_PREFIX}\n${summary}`
		};
		// The summary goes where the kept messages start; nothing is deleted,
		// so the scrollback stays whole and the model's view starts here.
		const cut = conversation.messages.indexOf(kept[0]);
		const newMessages: ChatMessage[] = [
			...conversation.messages.slice(0, cut),
			summaryMsg,
			...conversation.messages.slice(cut)
		];

		// messageSteps / messageStats are keyed by message INDEX — rewriting
		// the array without remapping them left artifacts and tok/s footers
		// rendering under unrelated messages (or vanishing).
		const newSteps = remapIndexedRecords(
			conversation.messages,
			newMessages,
			conversation.messageSteps
		);
		const newStats = remapIndexedRecords(
			conversation.messages,
			newMessages,
			conversation.messageStats
		);
		const newStops = remapIndexedRecords(
			conversation.messages,
			newMessages,
			conversation.messageStops
		);

		conversation.messages = newMessages;
		conversation.messageSteps = newSteps;
		conversation.messageStats = newStats;
		conversation.messageStops = newStops;
		conversation.contextUsage = null;
		// The turn `lastTurnTools` belonged to has just been summarized away;
		// keeping the raw tool messages would re-inflate the same context we
		// just compacted.
		conversation.lastTurnTools = undefined;
		if (getActiveConversationId() === conversation.id) resetContextUsage();

		await dbReplaceMessages(conversation.id, newMessages, newSteps);
	} finally {
		run.compacting = false;
	}
}

export function createConversation(): string {
	const id = generateId();
	const now = Date.now();
	conversations.unshift({
		id,
		title: 'New chat',
		messages: [],
		createdAt: now,
		updatedAt: now,
		contextUsage: null,
		searchSteps: [],
		messageSteps: {},
		messageStats: {},
		messageStops: {},
		sourceUrls: [],
		isRestoringSession: false,
		sessionRestoreSkipped: false,
		unread: false
	});
	const folder = getDefaultWorkingDir();
	setWorkingDirState(id, folder);
	// A folder picked with no chat open was for this one only.
	setDefaultWorkingDirState(undefined);
	setActiveConversationId(id);
	resetContextUsage();
	// Stored even when empty: a row without one would take the shared folder
	// at the next launch.
	void dbCreateConversation(id, 'New chat').then(() => dbSetWorkingDir(id, folder));
	return id;
}

function restoreContextUsageFor(id: string | null): void {
	const conv = conversations.find((c) => c.id === id);
	if (conv?.contextUsage) {
		setContextUsage(conv.contextUsage.promptTokens, conv.contextUsage.completionTokens);
	} else {
		resetContextUsage();
	}
}

/** The user has seen this conversation: clear its unread mark. */
export function markConversationRead(id: string): void {
	const conv = conversations.find((c) => c.id === id);
	if (!conv?.unread) return;
	conv.unread = false;
	void dbSetUnread(id, false);
}

// The chat the Remote control page last opened: it counts as seen there.
let viewedOnWeb: string | null = null;

/** The Remote control page opened this chat: it is read, and stays read while shown there. */
export function noteViewedOnWeb(id: string): void {
	viewedOnWeb = id;
	markConversationRead(id);
}

/** Open on the desktop, or on the Remote control page. */
function isConversationViewed(id: string): boolean {
	return getActiveConversationId() === id || viewedOnWeb === id;
}

/** A turn finished where the user isn't looking: mark it until they do. */
function markUnreadUnlessOpen(conversation: Conversation): void {
	if (isConversationViewed(conversation.id) || conversation.unread) return;
	conversation.unread = true;
	void dbSetUnread(conversation.id, true);
}

export async function setActiveConversation(id: string): Promise<void> {
	if (conversations.some((c) => c.id === id)) {
		// Leaving a conversation is the strongest signal it is finished, and
		// the trigger that catches someone who closes the app soon after.
		const leaving = getActiveConversationId();
		if (leaving && leaving !== id) noteConversationLeft(leaving);
		// A failed turn's banner stays with its conversation, and shows again
		// when the user comes back to it.
		setActiveConversationId(id);
		restoreContextUsageFor(id);
		await loadConversationMessages(id);
		// Fire-and-forget; the replay updates conv.isRestoringSession so
		// the UI can show a small indicator while it runs.
		void restoreSandboxSession(id);
		markConversationRead(id);
		void deliverNotices(id);
	}
}

/**
 * Maximum number of prior sandbox tool calls we'll replay when restoring
 * a chat's Python session. Above this, we skip replay (the user gets a
 * fresh sandbox, plus a `sessionRestoreSkipped` flag so the chat UI can
 * surface that state). Catches the pathological case of a chat with
 * hundreds of code runs that would block the UI for 30+ seconds.
 */
const SESSION_REPLAY_CAP = 50;

interface SandboxCallToReplay {
	name: 'run_python' | 'install_package' | 'reset_python';
	args: { code?: string; package?: string };
}

function collectSandboxCalls(messages: ChatMessage[]): SandboxCallToReplay[] {
	const out: SandboxCallToReplay[] = [];
	for (const msg of messages) {
		if (msg.role !== 'assistant' || !msg.tool_calls) continue;
		for (const call of msg.tool_calls) {
			const name = call.function?.name;
			if (name !== 'run_python' && name !== 'install_package' && name !== 'reset_python') continue;
			let args: { code?: string; package?: string };
			try {
				args = JSON.parse(call.function.arguments ?? '{}');
			} catch {
				continue;
			}
			out.push({ name, args });
		}
	}
	return out;
}

/**
 * Skip replay for code that launches long-running background tasks —
 * the original run already detached one game / animation, replay would
 * launch another, and after a few chat opens we'd have N parallel
 * pygame loops chewing the CPU.
 */
function isLongRunningLaunch(code: string): boolean {
	return /\b(asyncio\.ensure_future|asyncio\.create_task|haruspex\.spawn)\b/.test(code);
}

/**
 * Walk a chat's message history, find every prior install_package /
 * run_python / reset_python tool call, and replay them sequentially
 * against a fresh per-chat iframe so the model picks up where it left
 * off. Skipped entirely if the IframePool already has a live iframe
 * for this chat — its Python state hasn't been lost. Per-call errors
 * are swallowed (the chat history already records what the model saw
 * at the time; the goal is to rebuild state, not surface failures).
 * The active-chat guard aborts replay if the user switches to another
 * chat mid-flight.
 */
/** Replay one collected sandbox call during session restore. */
async function replaySandboxCall(chatId: string, call: SandboxCallToReplay): Promise<void> {
	if (call.name === 'install_package' && call.args.package) {
		await installPackage(chatId, call.args.package);
	} else if (call.name === 'run_python' && call.args.code) {
		if (isLongRunningLaunch(call.args.code)) {
			logDebug('sandbox', 'session restore: skipping long-running launch', {
				preview: call.args.code.slice(0, 60)
			});
			return;
		}
		await runPython(chatId, call.args.code);
	} else if (call.name === 'reset_python') {
		await resetSandbox(chatId);
	}
}

async function restoreSandboxSession(id: string): Promise<void> {
	const conv = conversations.find((c) => c.id === id);
	if (!conv) return;
	if (!getSettings().sandboxEnabled) return;
	// Worker pool keeps per-chat Workers alive across chat switches
	// (LRU cap 3). If this chat still has its Worker, Python state is
	// intact — skip replay entirely.
	if (hasLiveWorkerFor(id)) {
		logDebug('sandbox', 'session restore skipped — worker still live', { chatId: id });
		return;
	}
	const calls = collectSandboxCalls(conv.messages);
	if (calls.length === 0) return;
	if (calls.length > SESSION_REPLAY_CAP) {
		conv.sessionRestoreSkipped = true;
		logDebug('sandbox', 'session restore skipped — too many prior calls', {
			chatId: id,
			callCount: calls.length,
			cap: SESSION_REPLAY_CAP
		});
		return;
	}
	conv.isRestoringSession = true;
	conv.sessionRestoreSkipped = false;
	logDebug('sandbox', 'session restore start', { chatId: id, callCount: calls.length });
	try {
		// IframePool boots a fresh iframe lazily on the first runPython
		// for this chat — no explicit reset needed.
		for (const call of calls) {
			if (getActiveConversationId() !== id) {
				logDebug('sandbox', 'session restore aborted — chat switched', { fromChatId: id });
				return;
			}
			try {
				await replaySandboxCall(id, call);
			} catch (err) {
				logDebug('sandbox', `session restore: ${call.name} failed (skipping)`, {
					error: errMessage(err)
				});
			}
		}
		// Successful restore implies the user previously approved code in
		// this chat, so don't re-prompt on the next code call.
		approveChatSandbox(conv.id);
		logDebug('sandbox', 'session restore complete', { chatId: id });
	} finally {
		conv.isRestoringSession = false;
	}
}

export async function deleteConversation(id: string): Promise<void> {
	// Stop its turn, and drop a startup-queued send, so nothing runs against
	// a deleted conversation later.
	runs.get(id)?.cancel();
	runs.delete(id);
	const wasActive = getActiveConversationId() === id;
	conversations = conversations.filter((c) => c.id !== id);
	if (wasActive) {
		setActiveConversationId(conversations.length > 0 ? conversations[0].id : null);
		restoreContextUsageFor(getActiveConversationId());
	}
	forgetChatSandboxApproval(id);
	forgetWorkingDir(id);
	await dbDeleteConversation(id);
	// The delete cascades the conversation_images links away but cannot free
	// the bytes — that is the sweep's job, and running it now rather than at
	// next launch is what makes "delete the chat, delete its images" immediate.
	void sweepImages();
}

export async function renameConversation(id: string, title: string): Promise<void> {
	const conv = conversations.find((c) => c.id === id);
	if (conv) {
		conv.title = title;
		await dbRenameConversation(id, title);
	}
}

export async function clearAllConversations(): Promise<void> {
	for (const run of runs.values()) run.cancel();
	runs.clear();
	conversations = [];
	setActiveConversationId(null);
	clearWorkingDirs();
	await dbClearAll();
}

/**
 * Stop a conversation's turn: the open one's when no id is given. A send
 * queued for startup is unqueued; its message stays in history, and the
 * error banner's Retry dispatches it later.
 */
export function cancelGeneration(id = getActiveConversationId()): void {
	if (id) runs.get(id)?.cancel();
}

function extractUrlsFromSteps(steps: SearchStep[]): string[] {
	const urls: string[] = [];
	for (const step of steps) {
		if (step.toolName === 'fetch_url' && step.query) {
			if (step.status === 'done' && isFetchFailureResult(step.result)) continue;
			urls.push(step.query);
		} else if (step.toolName === 'research_url' && step.query) {
			if (step.status === 'done' && isFetchFailureResult(step.result)) continue;
			const dash = step.query.indexOf(' — ');
			urls.push(dash >= 0 ? step.query.slice(0, dash) : step.query);
		}
	}
	return [...new Set(urls)];
}

/**
 * Bookkeeping for a single in-flight turn. Held in a stable object so
 * the runAgentLoop callback bundle can mutate it and `commitMessage`
 * can read it back when building the persisted assistant message.
 */
interface TurnStats {
	lastCallStats: { durationMs: number; completionTokens: number } | null;
	/** `Date.now()` when the turn started, for the footer's elapsed figure. */
	startedAt: number;
}

function computeStats(stats: TurnStats): MessageStats | null {
	return computeMessageStats(stats.lastCallStats, Date.now() - stats.startedAt);
}

/**
 * The conversation a send goes to, when it may start a turn: `id`'s, or a
 * new one when `id` is null. `null` when the send must not start one (the
 * backend is down, or `id` names no conversation); the backend-down
 * rejection shows its own error toast, and the caller must leave the
 * composer text intact (nothing was consumed).
 */
function sendableConversation(id: string | null): Conversation | null {
	if (id && !conversations.some((c) => c.id === id)) return null;
	// Don't append silently-doomed work: with the server stopped or errored
	// the turn can only fail, so reject the send up front. 'starting' is
	// accepted — the message queues and auto-sends once the server is ready.
	const status = getServerState().status;
	if (status === 'stopped' || status === 'error') {
		showToast("The model isn't running. Check Settings → Inference backend.", { kind: 'error' });
		return null;
	}
	const target = id ?? createConversation();
	return conversations.find((c) => c.id === target) ?? null;
}

/** A user message: plain text, or content parts when there are images. */
function userMessageOf(text: string, images: string[]): ChatMessage {
	return {
		role: 'user',
		content: images.length
			? [
					...(text ? [{ type: 'text' as const, text }] : []),
					...images.map((url) => ({ type: 'image_url' as const, image_url: { url } }))
				]
			: text
	};
}

/**
 * Set the conversation title on the first turn, push the user message,
 * and persist it. Mutates the conversation in place.
 */
function finalizeUserTurn(
	conversation: Conversation,
	content: string,
	images: string[],
	skill?: SkillDoc
): void {
	// The first message the user sends titles the chat, even after a `/skills`
	// note opened it.
	if (!conversation.messages.some((m) => m.role === 'user')) {
		const title = generateTitle(content || 'Image');
		conversation.title = title;
		void dbRenameConversation(conversation.id, title);
	}
	const text = skill ? renderSlashMessage(skill, content.trim()) : content.trim();
	const userMessage = userMessageOf(text, images);
	conversation.messages.push(userMessage);
	conversation.updatedAt = Date.now();
	void dbSaveMessage(conversation.id, userMessage);
}

/**
 * Reset per-turn state (the run's streaming buffer, error indicators and
 * abort controller; the conversation's live steps) and start a fresh turn
 * id. Returns the new abort controller's signal.
 */
function resetTurnState(conversation: Conversation, run: ChatRun): AbortSignal {
	conversation.searchSteps = [];
	conversation.sourceUrls = [];
	return run.begin(beginTurn());
}

/**
 * Assemble the message array sent to the agent loop: system prompt
 * + history (filtered to user/assistant prose) + optional spliced
 * lastTurnTools + hint injection.
 */
function buildApiPrompt(
	conversation: Conversation,
	workingDir: string | null,
	keepRecentTools: boolean,
	exhaustive: boolean,
	memorySection: string,
	skillsSection = '',
	deferred?: DeferredFamily[]
): ChatMessage[] {
	// From the latest summary on (`chatModelView`): what came before it is
	// in the summary, and stays in the chat only for the reader.
	const historyMessages = chatModelView(conversation.messages).filter(
		(m) => m.role !== 'tool' && !m.tool_calls
	);
	// A turn stopped before any answer text leaves its message unanswered;
	// the next one says so, or the model takes that request up again.
	const unanswered = unansweredNotice(historyMessages);
	let messagesForApi: ChatMessage[] = [
		buildSystemPrompt(workingDir, {
			skillsSection,
			// Chat tab only. Jobs, remote guests and the shell assistant build
			// their prompts through the same function and must not get this.
			includeImages: getSettings().includeImages,
			imageModels: true,
			guide: true,
			feedback: true,
			lean: getSettings().leanMode,
			deferred
		}),
		...(unanswered ? withNotice(historyMessages, unanswered) : historyMessages)
	];

	// If the user opted in, splice the previous turn's tool_calls + tool
	// messages back into the prompt so the model can reference its own
	// research on followup questions. Insertion point is just before the
	// most recent assistant prose (the prior turn's final answer), so the
	// canonical sequence becomes:
	//   ...older history, user_{N-1}, [tool_calls + results], asst_{N-1}, user_N
	// preserving the OpenAI tool-call/result pairing.
	if (keepRecentTools && conversation.lastTurnTools && conversation.lastTurnTools.length > 0) {
		// Just-pushed user is at the end; the prior assistant prose sits at
		// length - 2. If the shape doesn't match (e.g. very first turn),
		// skip the splice rather than risk a malformed prompt.
		const insertIdx = messagesForApi.length - 2;
		if (insertIdx >= 0 && messagesForApi[insertIdx].role === 'assistant') {
			messagesForApi = [
				...messagesForApi.slice(0, insertIdx),
				...conversation.lastTurnTools,
				...messagesForApi.slice(insertIdx)
			];
		}
	}

	// Merge any additional leading system messages (e.g. a compaction
	// summary stored in history) into the single system prompt. Chat
	// templates like Qwen's reject a system message that isn't the very
	// first, so two leading system messages would 500 the request.
	messagesForApi = mergeLeadingSystemMessages(messagesForApi);

	messagesForApi = injectMessageHints(messagesForApi, {
		workingDir,
		exhaustiveResearch: exhaustive,
		lean: getSettings().leanMode,
		// On the latest user message, not the system prompt: it changes from
		// turn to turn, and the system prompt has to stay a cacheable prefix.
		memorySection
	});
	return messagesForApi;
}

/**
 * Persist a completed assistant message to the conversation: snapshot
 * the live search steps onto the message's index, attach per-message
 * tok/s stats, push the message, save to db, and clear the live steps
 * so the UI doesn't render the steps twice (live + persisted).
 */
function commitMessage(
	conversation: Conversation,
	content: string,
	stats: TurnStats,
	stopReason?: AgentStopReason
): void {
	const assistantMsg: ChatMessage = { role: 'assistant', content };
	const messageIndex = conversation.messages.length;
	// Record a system-forced stop (turn-limit / degraded output) so the log can
	// show why the turn ended and offer Continue. 'complete' = model's own call.
	if (stopReason && stopReason !== 'complete') {
		conversation.messageStops[messageIndex] = stopReason;
	}
	const stepsForThisTurn = conversation.searchSteps.filter(
		(s) => s.status === 'done' && (s.result || s.thumbDataUrl || s.artifacts?.length)
	);
	if (stepsForThisTurn.length > 0) {
		conversation.messageSteps[messageIndex] = stepsForThisTurn;
	}
	const messageStats = computeStats(stats);
	if (messageStats) {
		conversation.messageStats[messageIndex] = messageStats;
	}
	conversation.messages.push(assistantMsg);
	// Serialize the steps for persistence — inline images live inside
	// step.artifacts[].dataUrl (base64) so the row can get sizeable.
	// Acceptable: image artifacts are the whole point of saving them.
	const stepsJson = stepsForThisTurn.length > 0 ? JSON.stringify(stepsForThisTurn) : null;
	void dbSaveMessage(conversation.id, assistantMsg, stepsJson);
	conversation.searchSteps = [];
}

/**
 * After a successful runAgentLoop, capture any tool-call / tool-result
 * messages the loop appended so the next turn can optionally splice
 * them back in. We filter what the loop reported adding down to just
 * the messages that need to stay paired (assistant tool_calls + their
 * tool results) — recovery nudges like "Continue." aren't useful on
 * the next turn.
 */
function captureToolPairsForNextTurn(
	conversation: Conversation,
	appended: ChatMessage[],
	keepRecentTools: boolean
): void {
	if (keepRecentTools) {
		const toolPairs = appended.filter(
			(m) => m.role === 'tool' || (m.role === 'assistant' && m.tool_calls)
		);
		conversation.lastTurnTools = toolPairs.length > 0 ? toolPairs : undefined;
	} else {
		conversation.lastTurnTools = undefined;
	}
}

/**
 * Persist whatever content streamed before an AbortError, then clear
 * the live UI state. No-op if nothing streamed yet.
 */
function commitPartialOnAbort(conversation: Conversation, run: ChatRun, stats: TurnStats): void {
	if (!run.streamingContent) return;
	const fetched = extractUrlsFromSteps(conversation.searchSteps);
	const { content, citedUrls } = processCitations(run.streamingContent, fetched);
	commitMessage(conversation, content, stats);
	conversation.sourceUrls = citedUrls;
}

/**
 * Map a caught exception to the user-facing error banner. Aborts are
 * handled separately by commitPartialOnAbort and skip this path. The user
 * message is already in history, so retryLastTurn() just re-runs the turn.
 */
function handleTurnError(run: ChatRun, e: unknown): void {
	run.fail(e instanceof ApiError ? e.message : 'An unexpected error occurred.', run.currentTurnId);
}

/** The subset of AgentLoopOptions wired up per turn by sendMessage. */
type AgentLoopCallbacks = Pick<
	AgentLoopOptions,
	| 'onUsageUpdate'
	| 'onContextManaged'
	| 'onCallStats'
	| 'onToolStart'
	| 'onToolProgress'
	| 'onToolEnd'
	| 'onStreamChunk'
	| 'onComplete'
	| 'onError'
	| 'takeSteering'
	| 'onSteering'
>;

/**
 * Build the agent-loop callback bundle for one turn. Each callback closes
 * over the turn's `conversation`, its `run` (streaming content, context
 * notice, error fields) and the turn's `turnStats`.
 */
function buildAgentLoopCallbacks(
	conversation: Conversation,
	run: ChatRun,
	activeCtxSize: number,
	turnStats: TurnStats,
	exhaustive: boolean
): AgentLoopCallbacks {
	const thinkState = createThinkStreamState();
	return {
		onUsageUpdate: (u: Usage) => {
			// The gauge shows the open conversation; a turn elsewhere only
			// records its usage for when the user comes back.
			if (getActiveConversationId() === conversation.id) updateContextUsage(u, activeCtxSize);
			conversation.contextUsage = {
				promptTokens: u.prompt_tokens,
				completionTokens: u.completion_tokens
			};
		},
		onContextManaged: (info) => {
			run.contextNotice = describeContextManaged(info);
		},
		onCallStats: (stats) => {
			turnStats.lastCallStats = stats;
		},
		onToolStart: (call) => {
			conversation.searchSteps = [...conversation.searchSteps, newRunningStep(call)];
		},
		onToolProgress: (call, status) => {
			conversation.searchSteps = markStepProgress(conversation.searchSteps, call, status);
		},
		onToolEnd: (call, result, thumbDataUrl, artifacts, lintIssues, heroImage) => {
			conversation.searchSteps = markStepDone(
				conversation.searchSteps,
				call,
				result,
				thumbDataUrl,
				artifacts,
				lintIssues,
				heroImage
			);
		},
		onStreamChunk: (chunk) => {
			run.streamingContent = appendStreamDelta(run.streamingContent, chunk.delta, thinkState);
		},
		onComplete: (meta) => {
			// Steering the model never saw goes back to the input box. A
			// cancelled loop calls this only to hand it back, then throws.
			if (meta?.undeliveredSteering) run.handBack(meta.undeliveredSteering);
			if (meta?.aborted) return;
			finalizeStreamedTurn(conversation, run, turnStats, exhaustive, meta?.stopReason);
		},
		onError: (e) => handleTurnError(run, e),
		takeSteering: () => run.takeSteering(),
		onSteering: (steers) => {
			// Delivered: part of the conversation from here on, ahead of the
			// answer it steers.
			for (const m of steers) {
				const message = userMessageOf(m.text, m.images ?? []);
				conversation.messages.push(message);
				void dbSaveMessage(conversation.id, message);
			}
		}
	};
}

/**
 * A deep-research turn that answered turns the toggle back off — unless the
 * user has since switched it off and on again for another send.
 */
function endExhaustiveResearch(exhaustive: boolean): void {
	if (exhaustive && exhaustiveResearch) exhaustiveResearch = false;
}

/**
 * Commit (or diagnose) the streamed answer when the agent loop finishes.
 * Strips tool-call artifacts, resolves citations against the URLs fetched
 * this turn, then either commits the final message or surfaces an
 * empty-response diagnosis.
 */
function finalizeStreamedTurn(
	conversation: Conversation,
	run: ChatRun,
	turnStats: TurnStats,
	exhaustive: boolean,
	stopReason?: AgentStopReason
): void {
	const streamingContent = run.streamingContent;
	const fetched = extractUrlsFromSteps(conversation.searchSteps);
	const processed = processCitations(stripToolCallArtifacts(streamingContent).trim(), fetched);
	// A picture drawn, or a song made, this turn and left out of the answer is
	// placed after it.
	const finalContent = processed.content
		? placeGeneratedAudio(
				placeGeneratedImages(processed.content, conversation.searchSteps),
				conversation.searchSteps
			)
		: processed.content;
	// Snapshot before committing: commitMessage archives these into
	// messageSteps and then empties the live array, so anything reading
	// conversation.searchSteps afterwards sees nothing. Image resolution runs
	// after the commit by design and needs the turn's image_search results.
	const stepsThisTurn = [...conversation.searchSteps];

	if (finalContent) {
		logDebug('chat', 'onComplete commit', {
			rawStreamingLen: streamingContent.length,
			finalContentLen: finalContent.length,
			citedUrls: processed.citedUrls.map(urlForReport),
			stopReason
		});
		commitMessage(conversation, finalContent, turnStats, stopReason);
		endExhaustiveResearch(exhaustive);
	} else {
		const diagnosis = diagnoseEmptyResponse(conversation.searchSteps, streamingContent);
		logDebug('chat', `onComplete empty → diagnosis ${diagnosis.type}`, {
			rawStreamingLen: streamingContent.length,
			diagnosis
		});
		if (diagnosis.type === 'commit') {
			commitMessage(conversation, diagnosis.content, turnStats, stopReason);
			endExhaustiveResearch(exhaustive);
		} else {
			run.errorMessage = diagnosis.message;
			run.errorTurnId = run.currentTurnId;
		}
	}
	conversation.sourceUrls = processed.citedUrls;
	// Fetch any images the reply asked for that this conversation's own tool
	// results actually produced. Deliberately after commit and not awaited:
	// the answer is already on screen, and one slow image host must not delay
	// the turn being marked done. See images/resolve.
	if (finalContent) {
		void resolveReplyImages(
			conversation.id,
			finalContent,
			stepsThisTurn,
			() => getActiveConversationId() === conversation.id
		);
	}
	markUnreadUnlessOpen(conversation);
	// Arms the idle countdown; extraction itself happens minutes later, in
	// agent/memory/, and only when memory is on.
	noteTurnFinished(conversation.id);
}

/** Resume after a turn-limit / forced stop — the Continue button on the stop
 *  indicator. Same as the user typing "continue". */
export function continueTurn(id = getActiveConversationId()): Promise<boolean> {
	return sendMessageTo(id, 'Please continue from where you stopped.');
}

/** Text of the most recent user message — the turn being (re)run. */
function lastUserText(conversation: Conversation): string {
	for (let i = conversation.messages.length - 1; i >= 0; i--) {
		const m = conversation.messages[i];
		if (m.role === 'user') return typedText(messageText(m.content));
	}
	return '';
}

/** Park the turn until the sidecar finishes starting; clears stale errors. */
function queueTurnForStartup(run: ChatRun): void {
	run.queuedForStartup = true;
	run.clearError();
}

// Watches the server lifecycle while any send is queued for startup. Lives in
// a module-level $effect.root because this store is plain module state, not
// a component. On 'ready'/'remote' each queued turn dispatches exactly once
// (its flag is cleared before the run starts); on 'error'/'stopped' each
// converts into the standard error banner with Retry.
$effect.root(() => {
	$effect(() => {
		const { status, errorMessage: serverError } = getServerState();
		if (status === 'starting') return;
		for (const [id, run] of runs) {
			if (!run.queuedForStartup) continue;
			run.queuedForStartup = false;
			const conversation = conversations.find((c) => c.id === id);
			if (!conversation) continue;
			if (status === 'ready' || status === 'remote') {
				void runCurrentTurn(conversation);
			} else {
				run.fail(
					serverError ? `The model failed to start: ${serverError}` : 'The model failed to start.',
					null
				);
			}
		}
	});
});

/**
 * Re-run a conversation's last failed turn (the open one's by default). The
 * user message is already in history, so this clears the error state and
 * runs the turn again — no duplicate user bubble. If the server is (still)
 * starting — e.g. retrying right after cancelling a queued send — the retry
 * re-queues just like a fresh send.
 */
export async function retryLastTurn(id = getActiveConversationId()): Promise<void> {
	const conversation = conversations.find((c) => c.id === id);
	if (!conversation || conversation.messages.length === 0) return;
	const run = runFor(conversation.id);
	if (!run.lastTurnFailed || run.busy) return;
	if (getServerState().status === 'starting') {
		queueTurnForStartup(run);
		return;
	}
	await runCurrentTurn(conversation);
}

/** Send in the open conversation, or a new one when none is open. See `sendMessageTo`. */
export function sendMessage(
	content: string,
	images: string[] = [],
	/** A skill the user ran with `/name`, sent ahead of what they typed. */
	skill?: SkillDoc
): Promise<boolean> {
	return sendMessageTo(getActiveConversationId(), content, images, skill);
}

/**
 * Append the user's message to conversation `id` (a new one when null) and
 * dispatch the turn, without opening it. While that conversation's turn
 * runs, the message steers it instead: the model gets it at its next step
 * (a skill does not go with it; it only starts a turn).
 *
 * Returns `true` when the message was accepted (turn started, queued for
 * startup, or queued as steering) and `false` when the send was rejected
 * without consuming anything — the caller keeps its composer text. The
 * rejected path resolves synchronously (before any awaits), so callers can
 * clear optimistically and restore.
 */
export async function sendMessageTo(
	id: string | null,
	content: string,
	images: string[] = [],
	skill?: SkillDoc
): Promise<boolean> {
	if (!content.trim() && images.length === 0) return false;
	const running = id ? runs.get(id) : undefined;
	if (running?.busy) {
		running.steer({ text: content.trim(), images });
		return true;
	}
	const conversation = sendableConversation(id);
	if (!conversation) return false;
	const run = runFor(conversation.id);

	// A conversation that isn't open may not have its history loaded yet (a
	// notice turn sent to it); the turn needs it.
	if (conversation.id !== getActiveConversationId() && conversation.messages.length === 0) {
		await loadConversationMessages(conversation.id);
	}
	run.contextNotice = null;
	await compactIfNeeded(conversation, run, content);
	finalizeUserTurn(conversation, content, images, skill);

	// Locked startup behavior: a send while llama-server is still starting
	// stays visible in history and is auto-dispatched by the module-scope
	// watcher above the moment the server reports ready.
	if (getServerState().status === 'starting') {
		queueTurnForStartup(run);
		return true;
	}

	await runCurrentTurn(conversation);
	return true;
}

/**
 * Add a note to the conversation without a model call — what `/skills`
 * answers with. Stored as an assistant message, so it reads as a reply and
 * later turns see it as one.
 */
export function addLocalNote(text: string): void {
	if (activeRun().busy) return;
	if (!getActiveConversationId()) createConversation();
	const conversation = getActiveConversation();
	if (!conversation) return;
	const note: ChatMessage = { role: 'assistant', content: text };
	conversation.messages.push(note);
	conversation.updatedAt = Date.now();
	void dbSaveMessage(conversation.id, note);
}

/**
 * The user's own recent messages, oldest first, excluding the one being sent.
 *
 * Recall needs them because a follow-up is often unintelligible alone: "and
 * what about the other one?" retrieves nothing by itself. Only user turns —
 * assistant text would pull the query toward whatever the model last chose
 * to talk about.
 */
function priorUserTexts(conversation: Conversation): string[] {
	const texts = conversation.messages
		.filter((m) => m.role === 'user')
		.map((m) => typedText(messageText(m.content)));
	// The last one is the message being sent; recall already has it.
	return texts.slice(0, -1).slice(-2);
}

/**
 * Record which memories were injected, as a step on this turn.
 *
 * Rides the existing steps machinery so it persists with the message and
 * needs no new storage — and so "why did it say that?" has an answer sitting
 * next to the answer itself. Nothing recalled means no step at all, rather
 * than an empty one.
 */
function recordRecallStep(
	conversation: Conversation,
	turnId: number | null,
	memories: RecalledMemory[]
): void {
	if (memories.length === 0) return;
	conversation.searchSteps = [
		...conversation.searchSteps,
		{
			id: `memory-recall-${turnId}`,
			toolName: MEMORY_RECALL_STEP,
			query: `${memories.length} ${memories.length === 1 ? 'memory' : 'memories'} recalled`,
			status: 'done' as const,
			args: { memories }
		}
	];
}

/**
 * Run one agent turn against the conversation's existing history (the user
 * message is already appended). Shared by sendMessage, retryLastTurn and
 * the queued-startup watcher.
 */
async function runCurrentTurn(conversation: Conversation): Promise<void> {
	const run = runFor(conversation.id);
	const signal = resetTurnState(conversation, run);
	// Read once: the toggle belongs to the composer, and may change for
	// another conversation's send while this turn runs.
	const exhaustive = exhaustiveResearch;

	// Tok/s timing: the agent loop emits per-call timing via onCallStats.
	// Latch the most recent one — it corresponds to the model call whose
	// output is being committed. Earlier tool-decision calls get
	// overwritten by the final synthesis call, which is what we want.
	const turnStats: TurnStats = { lastCallStats: null, startedAt: Date.now() };

	try {
		const currentWorkingDir = getWorkingDirFor(conversation.id);
		const content = lastUserText(conversation);
		const expectsFileOutput = !!currentWorkingDir && looksLikeFileOutputRequest(content);

		const keepRecentTools = getSettings().keepRecentToolResults;

		// Chat always talks to the global Settings backend (no override).
		const backendDescriptor = resolveBackendDescriptor();
		const activeCtxSize = backendDescriptor.contextSize;

		// Once per USER turn, not per agent-loop iteration: tool calls reuse
		// the prompt built here. One embed plus one SQLite scan, both local —
		// a few milliseconds, and it short-circuits to nothing when memory is
		// off or this chat is incognito.
		const recalled = await recallForTurn({
			conversationId: conversation.id,
			userMessage: content,
			priorUserTurns: priorUserTexts(conversation),
			contextSize: activeCtxSize
		});
		recordRecallStep(conversation, run.currentTurnId, recalled);

		// Chat always uses the Settings backend, and has no project.
		const skills = await prepareTurnSkills({});

		const visionSupported = backendDescriptor.vision;
		const turnTools = chatTurnTools(conversation, currentWorkingDir, skills, exhaustive);

		// What the loop appends, for `lastTurnTools`. Not a slice of
		// `messagesForApi`: the context fit drops old turns from its front.
		const appended: ChatMessage[] = [];
		const messagesForApi = buildApiPrompt(
			conversation,
			currentWorkingDir,
			keepRecentTools,
			exhaustive,
			renderMemorySection(recalled),
			skillsPromptSection(skills),
			turnTools.deferredTools
		);

		run.waitingForSlot = true;
		await withInferenceSlot(
			{
				consumer: 'chat',
				signal,
				onAdmitted: () => {
					run.waitingForSlot = false;
				},
				// Taking its slot back after a long tool, it shows as waiting again.
				onRequeue: (ticket) => {
					run.waitingForSlot = ticket !== null;
				}
			},
			(slot) =>
				runAgentLoop({
					messages: messagesForApi,
					turnTools,
					workingDir: currentWorkingDir,
					maxIterations: chatTurnMaxIterations(getSettings().chatMaxIterations, exhaustive),
					contextSize: activeCtxSize,
					deepResearch: exhaustive,
					expectsFileOutput,
					visionSupported,
					interactive: true,
					conversationId: conversation.id,
					skills,
					signal,
					slot,
					...buildAgentLoopCallbacks(conversation, run, activeCtxSize, turnStats, exhaustive),
					onMessageAdded: (m) => appended.push(m)
				})
		);

		captureToolPairsForNextTurn(conversation, appended, keepRecentTools);
	} catch (e) {
		if (isAbortError(e)) {
			commitPartialOnAbort(conversation, run, turnStats);
		} else {
			handleTurnError(run, e);
		}
	} finally {
		// Only clears the run's state if this turn still owns it: the user can
		// cancel and dispatch a new turn while this one is still unwinding.
		run.end(signal);
		conversation.updatedAt = Date.now();
		if (!run.busy) {
			// Typed after the loop's last look at the queue: back to the input
			// box, like steering it ended without delivering.
			run.handBack(run.takeSteering());
			// A task that ended during this turn reports now; after this turn's
			// own bookkeeping, so it is a turn of its own.
			setTimeout(() => void deliverNotices(conversation.id), 0);
		}
	}
}
