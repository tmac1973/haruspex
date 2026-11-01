import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentLoopOptions } from '#lib/agent/loop.ts';

// Conversations running turns side by side: each has its own run state
// (streaming text, Stop, error banner), and one conversation's turn never
// blocks another's send. Mock setup mirrors chat.recovery.test.ts.

vi.mock('#lib/agent/loop.ts', () => ({
	runAgentLoop: vi.fn()
}));

const slots = vi.hoisted(() => ({
	fake: { held: true, release: () => {}, reacquire: async () => {} },
	/** Each turn's `onRequeue`, in the order the turns asked for a slot. */
	onRequeue: [] as ((ticket: unknown) => void)[]
}));

vi.mock('#lib/agent/loop/turnTools.ts', () => ({ resolveTurnTools: () => ({ tools: [] }) }));
vi.mock('#lib/agent/inferenceQueue.svelte.ts', () => ({
	withInferenceSlot: async <T>(
		opts: { onAdmitted?: () => void; onRequeue?: (ticket: unknown) => void },
		fn: (slot: unknown) => Promise<T>
	): Promise<T> => {
		if (opts.onRequeue) slots.onRequeue.push(opts.onRequeue);
		opts.onAdmitted?.();
		return fn(slots.fake);
	},
	getRunningCount: () => 0
}));

vi.mock('#lib/api.ts', async (importOriginal) => {
	// The pure helpers and error classes are the real ones; a copy here could
	// drift. The network calls are left out: nothing here should reach them.
	const {
		unansweredNotice,
		withNotice,
		mergeLeadingSystemMessages,
		ApiError,
		ResponseCutOffError,
		messageText
	} = await importOriginal<typeof import('#lib/api.ts')>();
	return {
		unansweredNotice,
		withNotice,
		mergeLeadingSystemMessages,
		ApiError,
		ResponseCutOffError,
		messageText
	};
});

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn().mockRejectedValue(new Error('not available'))
}));

// The task notices and store, reduced to what the chat store uses: the test
// queues a notice and calls the handler the store registered.
const tasks = vi.hoisted(() => ({
	handler: null as ((owner: string) => void) | null,
	pending: new Map<string, string>()
}));
vi.mock('#lib/tasks/notices.ts', () => ({
	setChatTaskHandler: (fn: (owner: string) => void) => {
		tasks.handler = fn;
		return () => {};
	},
	takeNotices: async (owner: string) => {
		const text = tasks.pending.get(owner) ?? '';
		tasks.pending.delete(owner);
		return { text, images: [] };
	}
}));
vi.mock('#lib/tasks/store.svelte.ts', () => ({
	hasPendingNotices: (owner: string) => tasks.pending.has(owner),
	initTasks: async () => {},
	ownersWithNotices: () => []
}));

const toasts = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('#lib/stores/toasts.svelte.ts', () => toasts);

describe('concurrent chat conversations', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		slots.onRequeue = [];
	});

	async function setup() {
		const chat = await import('#lib/stores/chat.svelte.ts');
		const { getServerState } = await import('#lib/stores/llamaServer.svelte.ts');
		getServerState().status = 'ready';
		return chat;
	}

	async function settle(): Promise<void> {
		for (let i = 0; i < 30; i++) await Promise.resolve();
	}

	/**
	 * A model that streams `text` and then waits until the test lets it
	 * finish (or the turn is stopped), so turns can overlap. Like the real
	 * loop, it delivers queued steering before it finishes, and hands back
	 * what it never delivered when stopped.
	 */
	async function heldTurns() {
		const { runAgentLoop } = await import('#lib/agent/loop.ts');
		const finish = new Map<string, () => void>();
		vi.mocked(runAgentLoop).mockImplementation(
			(options: AgentLoopOptions) =>
				new Promise<void>((resolve, reject) => {
					const id = options.conversationId!;
					options.onStreamChunk({ delta: { content: `answer in ${id}` }, finish_reason: null });
					options.signal?.addEventListener('abort', () => {
						const left = options.takeSteering?.() ?? [];
						if (left.length) {
							options.onComplete({
								stopReason: 'complete',
								aborted: true,
								undeliveredSteering: left
							});
						}
						reject(new DOMException('aborted', 'AbortError'));
					});
					finish.set(id, () => {
						const steers = options.takeSteering?.() ?? [];
						if (steers.length) options.onSteering?.(steers);
						options.onComplete();
						resolve();
					});
				})
		);
		return finish;
	}

	it('runs a turn in a second conversation while the first is still running', async () => {
		const finish = await heldTurns();
		const chat = await setup();

		const a = chat.createConversation();
		const sentA = chat.sendMessage('first');
		await settle();
		const b = chat.createConversation();
		const sentB = chat.sendMessage('second');
		await settle();

		expect(chat.getRun(a).generating).toBe(true);
		expect(chat.getRun(b).generating).toBe(true);
		expect(chat.getRun(a).streamingContent).toBe(`answer in ${a}`);
		expect(chat.getRun(b).streamingContent).toBe(`answer in ${b}`);
		// The getters report the open conversation.
		expect(chat.getStreamingContent()).toBe(`answer in ${b}`);

		finish.get(a)!();
		await sentA;
		expect(chat.getRun(a).generating).toBe(false);
		expect(chat.getRun(b).generating).toBe(true);

		finish.get(b)!();
		await sentB;
		const conv = (id: string) => chat.getConversations().find((c) => c.id === id)!;
		expect(conv(a).messages.map((m) => m.content)).toEqual(['first', `answer in ${a}`]);
		expect(conv(b).messages.map((m) => m.content)).toEqual(['second', `answer in ${b}`]);
	});

	it('gives the loop its slot, and shows it waiting while it takes the slot back', async () => {
		const finish = await heldTurns();
		const chat = await setup();
		const { runAgentLoop } = await import('#lib/agent/loop.ts');

		const a = chat.createConversation();
		const sent = chat.sendMessage('first');
		await settle();
		expect(vi.mocked(runAgentLoop).mock.calls[0][0].slot).toBe(slots.fake);
		expect(chat.getRun(a).waitingForSlot).toBe(false);

		slots.onRequeue[0]({ id: 'main:2', consumer: 'chat', state: 'waiting', enqueuedAt: 0 });
		expect(chat.getRun(a).waitingForSlot).toBe(true);
		slots.onRequeue[0](null);
		expect(chat.getRun(a).waitingForSlot).toBe(false);

		finish.get(a)!();
		await sent;
	});

	it('steers a busy conversation with a second send, ahead of the answer', async () => {
		const { runAgentLoop } = await import('#lib/agent/loop.ts');
		const finish = await heldTurns();
		const chat = await setup();

		const a = chat.createConversation();
		const sent = chat.sendMessage('first');
		await settle();
		expect(await chat.sendMessage('also this')).toBe(true);
		expect(chat.getRun(a).steering).toEqual([{ text: 'also this', images: [] }]);
		// No second turn: the running one takes it.
		expect(runAgentLoop).toHaveBeenCalledTimes(1);

		finish.get(a)!();
		await sent;
		const conv = chat.getConversations().find((c) => c.id === a)!;
		expect(conv.messages.map((m) => m.content)).toEqual(['first', 'also this', `answer in ${a}`]);
		expect(chat.getRun(a).steering).toEqual([]);
	});

	it('hands steering a stopped turn never delivered back to the input box', async () => {
		await heldTurns();
		const chat = await setup();

		const a = chat.createConversation();
		const sent = chat.sendMessage('first');
		await settle();
		await chat.sendMessage('never mind');
		chat.cancelGeneration(a);
		await sent;

		const conv = chat.getConversations().find((c) => c.id === a)!;
		expect(conv.messages.map((m) => m.content)).not.toContain('never mind');
		expect(chat.getRun(a).takeReturned()).toEqual({ text: ['never mind'], images: [] });
	});

	it('marks a conversation unread when its turn ends elsewhere, until it is opened', async () => {
		const finish = await heldTurns();
		const chat = await setup();

		const a = chat.createConversation();
		const sent = chat.sendMessage('first');
		await settle();
		chat.createConversation();

		finish.get(a)!();
		await sent;
		const conv = () => chat.getConversations().find((c) => c.id === a)!;
		expect(conv().unread).toBe(true);

		await chat.setActiveConversation(a);
		expect(conv().unread).toBe(false);
	});

	/** A video task ended for `id`. */
	function taskEnded(id: string, notice: string): void {
		tasks.pending.set(`chat:${id}`, notice);
		tasks.handler!(`chat:${id}`);
	}

	it('runs a notice turn in an idle conversation that is not open, and says so', async () => {
		const finish = await heldTurns();
		const chat = await setup();
		await chat.initChatStore();

		const a = chat.createConversation();
		const b = chat.createConversation();
		taskEnded(a, 'Video render finished: /tmp/a.mp4.');
		await settle();

		expect(chat.getActiveConversationId()).toBe(b);
		expect(chat.getRun(a).generating).toBe(true);
		expect(toasts.showToast).toHaveBeenCalledWith(
			chat.noticeToast('New chat'),
			expect.objectContaining({ actionLabel: 'Open' })
		);

		finish.get(a)!();
		await settle();
		const conv = chat.getConversations().find((c) => c.id === a)!;
		expect(conv.messages[0].content).toBe('Video render finished: /tmp/a.mp4.');
		expect(conv.unread).toBe(true);
	});

	it('holds a notice for a busy conversation until its turn ends', async () => {
		const { runAgentLoop } = await import('#lib/agent/loop.ts');
		const finish = await heldTurns();
		const chat = await setup();
		await chat.initChatStore();

		const a = chat.createConversation();
		const sent = chat.sendMessage('first');
		await settle();
		taskEnded(a, 'Video render finished: /tmp/a.mp4.');
		await settle();
		expect(runAgentLoop).toHaveBeenCalledTimes(1);

		finish.get(a)!();
		await sent;
		await new Promise((r) => setTimeout(r, 0));
		await settle();
		expect(runAgentLoop).toHaveBeenCalledTimes(2);
		const conv = chat.getConversations().find((c) => c.id === a)!;
		expect(conv.messages.map((m) => m.content).slice(0, 3)).toEqual([
			'first',
			`answer in ${a}`,
			'Video render finished: /tmp/a.mp4.'
		]);
	});

	it('does not mark unread a conversation shown on the Remote control page', async () => {
		const finish = await heldTurns();
		const chat = await setup();

		const a = chat.createConversation();
		const sent = chat.sendMessage('first');
		await settle();
		chat.createConversation();
		chat.noteViewedOnWeb(a);

		finish.get(a)!();
		await sent;
		expect(chat.getConversations().find((c) => c.id === a)!.unread).toBe(false);
	});

	it('does not mark the open conversation unread', async () => {
		const finish = await heldTurns();
		const chat = await setup();

		const a = chat.createConversation();
		const sent = chat.sendMessage('first');
		await settle();
		finish.get(a)!();
		await sent;

		expect(chat.getConversations().find((c) => c.id === a)!.unread).toBe(false);
	});

	it('stopping one conversation leaves the other running', async () => {
		const finish = await heldTurns();
		const chat = await setup();

		const a = chat.createConversation();
		const sentA = chat.sendMessage('first');
		await settle();
		const b = chat.createConversation();
		const sentB = chat.sendMessage('second');
		await settle();

		chat.cancelGeneration(b);
		await sentB;
		expect(chat.getRun(b).generating).toBe(false);
		expect(chat.getRun(a).generating).toBe(true);

		finish.get(a)!();
		await sentA;
	});

	it('tells the next turn that the user stopped the one before it answered', async () => {
		const { runAgentLoop } = await import('#lib/agent/loop.ts');
		const { UNANSWERED_NOTICE } =
			await vi.importActual<typeof import('#lib/api.ts')>('#lib/api.ts');
		// Stopped mid-tool-call: no answer text has streamed.
		vi.mocked(runAgentLoop).mockImplementationOnce(
			(options: AgentLoopOptions) =>
				new Promise<void>((_resolve, reject) => {
					options.signal?.addEventListener('abort', () =>
						reject(new DOMException('aborted', 'AbortError'))
					);
				})
		);
		const chat = await setup();

		const a = chat.createConversation();
		const stopped = chat.sendMessage('run the long build');
		await settle();
		chat.cancelGeneration(a);
		await stopped;

		vi.mocked(runAgentLoop).mockImplementationOnce(async (options) => options.onComplete());
		await chat.sendMessage('what does stats.js export?');
		const opening = String(vi.mocked(runAgentLoop).mock.calls.at(-1)![0].messages.at(-1)?.content);
		expect(opening).toContain(UNANSWERED_NOTICE);
		expect(opening).toContain('what does stats.js export?');
	});

	it("shows a failed turn's error only in its own conversation", async () => {
		const { runAgentLoop } = await import('#lib/agent/loop.ts');
		vi.mocked(runAgentLoop).mockRejectedValueOnce(new Error('boom'));
		const chat = await setup();

		const a = chat.createConversation();
		await chat.sendMessage('first');
		expect(chat.getErrorMessage()).toBe('An unexpected error occurred.');

		const b = chat.createConversation();
		expect(chat.getActiveConversationId()).toBe(b);
		expect(chat.getErrorMessage()).toBeNull();

		await chat.setActiveConversation(a);
		expect(chat.getErrorMessage()).toBe('An unexpected error occurred.');
		expect(chat.getLastTurnFailed()).toBe(true);
	});

	it('deleting a busy conversation stops its turn', async () => {
		await heldTurns();
		const chat = await setup();

		const a = chat.createConversation();
		const sent = chat.sendMessage('first');
		await settle();
		const run = chat.getRun(a);
		expect(run.generating).toBe(true);

		await chat.deleteConversation(a);
		await sent;
		expect(run.generating).toBe(false);
		expect(chat.getRun(a).generating).toBe(false);
	});
});
