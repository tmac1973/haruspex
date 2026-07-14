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
	retryLastTurn
} from '$lib/stores/chat.svelte';

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn().mockRejectedValue(new Error('not available'))
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

// The real chat store pulls in Tauri IPC + the server store; ChatView (and
// its children ConversationSidebar / WorkingDirButton) only need the
// functions they import, so mock the whole module.
vi.mock('$lib/stores/chat.svelte', () => ({
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
	// ConversationSidebar
	clearAllConversations: vi.fn(),
	deleteConversation: vi.fn(),
	getActiveConversationId: vi.fn(() => 'c1'),
	getConversations: vi.fn(() => []),
	renameConversation: vi.fn(),
	setActiveConversation: vi.fn(),
	// WorkingDirButton
	getWorkingDir: vi.fn(() => null),
	setWorkingDir: vi.fn()
}));

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
		expect(screen.getByText('An unexpected error occurred.')).toBeTruthy();
		expect(screen.getByText('Copy debug log')).toBeTruthy();

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
		expect(screen.getByText('An unexpected error occurred.')).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
	});
});
