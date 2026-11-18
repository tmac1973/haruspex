import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import ChatView from './ChatView.svelte';
import {
	getActiveConversation,
	getConversations,
	getErrorMessage,
	getErrorTurnId,
	getIsGenerating,
	getLastTurnFailed,
	hasConversationDraft,
	retryLastTurn,
	sendMessage,
	takeConversationDraft
} from '#lib/stores/chat.svelte.ts';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore({}, () => {
		throw new Error('not available');
	})
);
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

// The real chat store pulls in Tauri IPC + the server store; ChatView (and
// its children ConversationSidebar / WorkingDirButton) only need the
// functions they import, so mock the whole module.
vi.mock('#lib/stores/chat.svelte.ts', async () => {
	const m = {
		addLocalNote: vi.fn(),
		getActiveConversation: vi.fn(),
		getIsGenerating: vi.fn(() => false),
		getIsWaitingForSlot: vi.fn(() => false),
		getIsCompacting: vi.fn(() => false),
		getContextNotice: vi.fn(() => null),
		getStreamingContent: vi.fn(() => ''),
		getErrorMessage: vi.fn(() => null),
		getErrorTurnId: vi.fn(() => null),
		getLastTurnFailed: vi.fn(() => false),
		getQueuedForStartup: vi.fn(() => false),
		getSearchSteps: vi.fn(() => []),
		getSourceUrls: vi.fn(() => []),
		getExhaustiveResearch: vi.fn(() => false),
		renderStreamingHtml: vi.fn(() => ''),
		setExhaustiveResearch: vi.fn(),
		createConversation: vi.fn(),
		sendMessage: vi.fn(),
		continueTurn: vi.fn(),
		cancelGeneration: vi.fn(),
		retryLastTurn: vi.fn(),
		isActiveConversationRemembered: vi.fn(() => true),
		isActiveConversationRemote: vi.fn(() => false),
		setConversationMemoryEnabled: vi.fn(),
		getActiveRun: vi.fn(() => ({
			steering: [],
			returnedText: [],
			returnedImages: [],
			takeReturned: () => ({ text: [], images: [] })
		})),
		dropSteering: vi.fn(),
		hasConversationDraft: vi.fn(() => false),
		takeConversationDraft: vi.fn(() => null),
		// ConversationSidebar
		getRun: vi.fn(() => ({ generating: false, waitingForSlot: false, queuedForStartup: false })),
		clearAllConversations: vi.fn(),
		deleteConversation: vi.fn(),
		getActiveConversationId: vi.fn(() => 'c1'),
		getConversations: vi.fn(() => []),
		renameConversation: vi.fn(),
		setActiveConversation: vi.fn(),
		// WorkingDirButton
		getWorkingDir: vi.fn(() => null),
		setWorkingDir: vi.fn()
	};
	// ChatView reads them through the local source, as the real store builds it.
	const { ALL_CHAT_CAPABILITIES } = await import('#lib/chat/source.ts');
	const localChatSource = {
		capabilities: ALL_CHAT_CAPABILITIES,
		get conversation() {
			return m.getActiveConversation();
		},
		get isGenerating() {
			return m.getIsGenerating();
		},
		get isWaitingForSlot() {
			return m.getIsWaitingForSlot();
		},
		get isCompacting() {
			return m.getIsCompacting();
		},
		get contextNotice() {
			return m.getContextNotice();
		},
		get streamingContent() {
			return m.getStreamingContent();
		},
		get errorMessage() {
			return m.getErrorMessage();
		},
		get errorTurnId() {
			return m.getErrorTurnId();
		},
		get searchSteps() {
			return m.getSearchSteps();
		},
		get sourceUrls() {
			return m.getSourceUrls();
		},
		get exhaustiveResearch() {
			return m.getExhaustiveResearch();
		},
		get lastTurnFailed() {
			return m.getLastTurnFailed();
		},
		get queuedForStartup() {
			return m.getQueuedForStartup();
		},
		get activeRun() {
			return m.getActiveRun();
		},
		get remembered() {
			return m.isActiveConversationRemembered();
		},
		get isRemote() {
			return m.isActiveConversationRemote();
		},
		renderStreamingHtml: () => m.renderStreamingHtml(),
		setExhaustiveResearch: (v: boolean) => m.setExhaustiveResearch(v),
		createConversation: () => m.createConversation(),
		sendMessage: (...a: unknown[]) => (m.sendMessage as (...a: unknown[]) => unknown)(...a),
		continueTurn: () => m.continueTurn(),
		cancelGeneration: () => m.cancelGeneration(),
		retryLastTurn: () => m.retryLastTurn(),
		setMemoryEnabled: (...a: unknown[]) =>
			(m.setConversationMemoryEnabled as (...a: unknown[]) => unknown)(...a),
		addLocalNote: (t: string) => m.addLocalNote(t),
		dropSteering: (k: number) => m.dropSteering(k),
		hasDraft: (id: string) => (m.hasConversationDraft as (id: string) => boolean)(id),
		takeDraft: (id: string) => (m.takeConversationDraft as (id: string) => string | null)(id)
	};
	return { ...m, localChatSource };
});

// The handoff pulls in the shell registry + the activeTab store; here we only
// care that the button wires to it with the conversation.
const openShellFromChat = vi.hoisted(() => vi.fn());
vi.mock('#lib/shell/fromChat.ts', () => ({ openShellFromChat }));

const conversation = {
	id: 'c1',
	title: 'Chat',
	messages: [{ role: 'user', content: 'hi' }],
	createdAt: 0,
	updatedAt: 0,
	contextUsage: null,
	searchSteps: [],
	messageSteps: {},
	messageStats: {},
	messageStops: {},
	sourceUrls: [],
	isRestoringSession: false,
	sessionRestoreSkipped: false
} as unknown as ReturnType<typeof getActiveConversation>;

describe('ChatView error banner', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getActiveConversation).mockReturnValue(conversation);
		vi.mocked(getConversations).mockReturnValue([conversation] as unknown as ReturnType<
			typeof getConversations
		>);
		vi.mocked(getErrorMessage).mockReturnValue('An unexpected error occurred.');
		vi.mocked(getErrorTurnId).mockReturnValue(7);
		vi.mocked(getLastTurnFailed).mockReturnValue(true);
		vi.mocked(getIsGenerating).mockReturnValue(false);
	});

	it('renders Retry next to Copy debug log and invokes the store', async () => {
		render(ChatView);
		screen.getByText('An unexpected error occurred.');
		screen.getByText('Copy debug log');

		const retry = screen.getByRole('button', { name: 'Retry' });
		await fireEvent.click(retry);

		expect(retryLastTurn).toHaveBeenCalledTimes(1);
	});

	it('disables Retry while a generation is in flight', () => {
		vi.mocked(getIsGenerating).mockReturnValue(true);
		render(ChatView);
		const retry = screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement;
		expect(retry.disabled).toBe(true);
	});

	it('omits Retry for non-retryable errors (lastTurnFailed false)', () => {
		vi.mocked(getLastTurnFailed).mockReturnValue(false);
		render(ChatView);
		screen.getByText('An unexpected error occurred.');
		expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
	});
});

describe('ChatView "Open in shell"', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getActiveConversation).mockReturnValue(conversation);
		vi.mocked(getConversations).mockReturnValue([conversation] as unknown as ReturnType<
			typeof getConversations
		>);
		vi.mocked(getErrorMessage).mockReturnValue(null);
		vi.mocked(getIsGenerating).mockReturnValue(false);
	});

	it('hands the active conversation to a shell session', async () => {
		render(ChatView);
		await fireEvent.click(screen.getByRole('button', { name: 'Open in shell' }));
		expect(openShellFromChat).toHaveBeenCalledWith({
			title: 'Chat',
			messages: conversation!.messages
		});
	});

	it('is disabled mid-generation, so a streaming answer is not carried half-written', () => {
		vi.mocked(getIsGenerating).mockReturnValue(true);
		render(ChatView);
		const btn = screen.getByRole('button', { name: 'Open in shell' }) as HTMLButtonElement;
		expect(btn.disabled).toBe(true);
	});

	it('is disabled with no conversation open', () => {
		vi.mocked(getActiveConversation).mockReturnValue(undefined);
		render(ChatView);
		const btn = screen.getByRole('button', { name: 'Open in shell' }) as HTMLButtonElement;
		expect(btn.disabled).toBe(true);
	});
});

describe('ChatView input history', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getActiveConversation).mockReturnValue({
			...conversation!,
			messages: [
				{ role: 'user', content: 'first question' },
				{ role: 'assistant', content: 'an answer' },
				{ role: 'user', content: 'second question' }
			]
		} as unknown as ReturnType<typeof getActiveConversation>);
		vi.mocked(getConversations).mockReturnValue([]);
		vi.mocked(getErrorMessage).mockReturnValue(null as unknown as string);
		vi.mocked(getIsGenerating).mockReturnValue(false);
	});

	it('steps back through what was sent with Up, and forward to the draft with Down', async () => {
		render(ChatView);
		const box = screen.getByRole('textbox') as HTMLTextAreaElement;
		await fireEvent.input(box, { target: { value: 'draft' } });
		await fireEvent.keyDown(box, { key: 'ArrowUp' });
		expect(box.value).toBe('second question');
		box.setSelectionRange(0, 0);
		await fireEvent.keyDown(box, { key: 'ArrowUp' });
		expect(box.value).toBe('first question');
		box.setSelectionRange(box.value.length, box.value.length);
		await fireEvent.keyDown(box, { key: 'ArrowDown' });
		await fireEvent.keyDown(box, { key: 'ArrowDown' });
		expect(box.value).toBe('draft');
	});
});

describe('ChatView — a chat started from Home', () => {
	it('opens with the draft in the box, unsent', async () => {
		vi.clearAllMocks();
		vi.mocked(getActiveConversation).mockReturnValue(conversation);
		vi.mocked(getConversations).mockReturnValue([]);
		vi.mocked(getErrorMessage).mockReturnValue(null as unknown as string);
		vi.mocked(getIsGenerating).mockReturnValue(false);
		vi.mocked(hasConversationDraft).mockReturnValue(true);
		vi.mocked(takeConversationDraft).mockReturnValue('From my News card on Home:\n\n> Launch\n\n');

		render(ChatView);
		const box = screen.getByRole('textbox') as HTMLTextAreaElement;
		await vi.waitFor(() => expect(box.value).toContain('> Launch'));
		expect(takeConversationDraft).toHaveBeenCalledWith(conversation!.id);
		expect(sendMessage).not.toHaveBeenCalled();
	});
});

describe('ChatView with another source', () => {
	/** A conversation that isn't this computer's: none of its controls apply. */
	function remoteSource(sendMessage = vi.fn(async () => true)) {
		return {
			capabilities: {
				deepResearch: false,
				workingFolder: false,
				incognito: false,
				screenCapture: false,
				mic: false,
				localServer: false,
				openInShell: false
			},
			conversation,
			isGenerating: false,
			isWaitingForSlot: false,
			isCompacting: false,
			contextNotice: null,
			streamingContent: '',
			errorMessage: null,
			errorTurnId: null,
			searchSteps: [],
			sourceUrls: [],
			exhaustiveResearch: false,
			lastTurnFailed: false,
			queuedForStartup: false,
			activeRun: {
				steering: [],
				returnedText: [],
				returnedImages: [],
				takeReturned: () => ({ text: [], images: [] })
			},
			remembered: false,
			isRemote: false,
			renderStreamingHtml: () => '',
			setExhaustiveResearch: vi.fn(),
			createConversation: vi.fn(),
			sendMessage,
			continueTurn: vi.fn(async () => true),
			cancelGeneration: vi.fn(),
			retryLastTurn: vi.fn(async () => {}),
			setMemoryEnabled: vi.fn(async () => {}),
			addLocalNote: vi.fn(),
			dropSteering: vi.fn(),
			hasDraft: () => false,
			takeDraft: () => null
		} as unknown as import('#lib/chat/source.ts').ChatSource;
	}

	const controls = [
		'.workingdir-btn',
		'.capture-btn',
		'.open-shell-btn',
		'.research-toggle',
		'.incognito-toggle',
		'.mic-btn'
	];

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getActiveConversation).mockReturnValue(conversation);
	});

	it('hides every control whose capability is off, and sends through the source', async () => {
		const send = vi.fn(async () => true);
		const { container } = render(ChatView, { source: remoteSource(send) });
		for (const sel of controls) expect(container.querySelector(sel), sel).toBeNull();
		// Its own model answers: this computer's server isn't waited for.
		const box = screen.getByRole('textbox') as HTMLTextAreaElement;
		expect(box.disabled).toBe(false);
		await fireEvent.input(box, { target: { value: 'hello there' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Send' }));
		await vi.waitFor(() => expect(send).toHaveBeenCalled());
		expect((send.mock.calls[0] as unknown[])[0]).toBe('hello there');
		expect(vi.mocked(sendMessage)).not.toHaveBeenCalled();
	});

	it('shows them for this computer', () => {
		const { container } = render(ChatView);
		for (const sel of ['.workingdir-btn', '.capture-btn', '.open-shell-btn', '.research-toggle'])
			expect(container.querySelector(sel), sel).not.toBeNull();
	});
});
