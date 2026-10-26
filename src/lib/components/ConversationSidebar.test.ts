import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import ConversationSidebar from './ConversationSidebar.svelte';
import {
	clearAllConversations,
	deleteConversation,
	getConversations,
	getRun,
	renameConversation
} from '#lib/stores/chat.svelte.ts';

// The real chat store pulls in Tauri IPC; the sidebar only needs the
// handful of functions it imports, so mock the whole module.
vi.mock('#lib/stores/chat.svelte.ts', () => ({
	clearAllConversations: vi.fn(),
	createConversation: vi.fn(),
	deleteConversation: vi.fn(),
	getActiveConversationId: vi.fn(() => 'c1'),
	getConversations: vi.fn(),
	getRun: vi.fn(() => ({
		generating: false,
		waitingForSlot: false,
		queuedForStartup: false,
		compacting: false
	})),
	renameConversation: vi.fn(),
	setActiveConversation: vi.fn()
}));

// The sidebar only reads id + title off each conversation.
const conversations = [
	{ id: 'c1', title: 'First chat' },
	{ id: 'c2', title: 'Second chat' }
];

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getConversations).mockReturnValue(
		conversations as unknown as ReturnType<typeof getConversations>
	);
});

function rowDeleteButtons() {
	return screen.getAllByTitle('Delete conversation');
}

describe('ConversationSidebar delete confirmation', () => {
	it('clicking a row delete opens the dialog without deleting', async () => {
		render(ConversationSidebar);
		await fireEvent.click(rowDeleteButtons()[0]);
		expect(screen.getByText('Delete conversation?')).toBeTruthy();
		expect(screen.getByText('"First chat" will be permanently deleted.')).toBeTruthy();
		expect(deleteConversation).not.toHaveBeenCalled();
	});

	it('confirming deletes the right conversation and closes the dialog', async () => {
		render(ConversationSidebar);
		await fireEvent.click(rowDeleteButtons()[1]);
		await fireEvent.click(screen.getByText('Delete'));
		expect(deleteConversation).toHaveBeenCalledTimes(1);
		expect(deleteConversation).toHaveBeenCalledWith('c2');
		expect(screen.queryByText('Delete conversation?')).toBeNull();
	});

	it('cancelling leaves everything untouched', async () => {
		render(ConversationSidebar);
		await fireEvent.click(rowDeleteButtons()[0]);
		await fireEvent.click(screen.getByText('Cancel'));
		expect(deleteConversation).not.toHaveBeenCalled();
		expect(screen.queryByText('Delete conversation?')).toBeNull();
	});

	it('Escape cancels without deleting', async () => {
		render(ConversationSidebar);
		await fireEvent.click(rowDeleteButtons()[0]);
		await fireEvent.keyDown(window, { key: 'Escape' });
		expect(deleteConversation).not.toHaveBeenCalled();
		expect(screen.queryByText('Delete conversation?')).toBeNull();
	});

	it('clear-all goes through its own confirmation', async () => {
		render(ConversationSidebar);
		await fireEvent.click(screen.getByText('Clear all'));
		expect(screen.getByText('Delete all conversations?')).toBeTruthy();
		expect(clearAllConversations).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByText('Delete all'));
		expect(clearAllConversations).toHaveBeenCalledTimes(1);
		expect(screen.queryByText('Delete all conversations?')).toBeNull();
	});
});

describe('ConversationSidebar rename affordance', () => {
	it('pencil button enters the inline rename state', async () => {
		render(ConversationSidebar);
		await fireEvent.click(screen.getAllByLabelText('Rename conversation')[0]);
		const input = screen.getByDisplayValue('First chat');
		expect(input).toBeTruthy();
		expect(renameConversation).not.toHaveBeenCalled();
	});

	it('pencil-initiated rename commits on Enter', async () => {
		render(ConversationSidebar);
		await fireEvent.click(screen.getAllByLabelText('Rename conversation')[1]);
		const input = screen.getByDisplayValue('Second chat');
		await fireEvent.input(input, { target: { value: 'Renamed chat' } });
		await fireEvent.keyDown(input, { key: 'Enter' });
		expect(renameConversation).toHaveBeenCalledTimes(1);
		expect(renameConversation).toHaveBeenCalledWith('c2', 'Renamed chat');
	});
});

describe('ConversationSidebar marks', () => {
	type Run = ReturnType<typeof getRun>;

	it('marks a working, a waiting and an unread conversation, and leaves an idle one bare', () => {
		vi.mocked(getConversations).mockReturnValue([
			{ id: 'c1', title: 'Working' },
			{ id: 'c2', title: 'Waiting' },
			{ id: 'c3', title: 'Unread', unread: true },
			{ id: 'c4', title: 'Idle' }
		] as unknown as ReturnType<typeof getConversations>);
		vi.mocked(getRun).mockImplementation(
			(id: string) =>
				({
					generating: id === 'c1' || id === 'c2',
					waitingForSlot: id === 'c2',
					queuedForStartup: false,
					compacting: false
				}) as Run
		);

		const { container } = render(ConversationSidebar);
		const marks = [...container.querySelectorAll('[data-mark]')].map((m) =>
			m.getAttribute('data-mark')
		);
		expect(marks).toEqual(['running', 'queued', 'unread']);
		expect(screen.getByLabelText('Finished while you were elsewhere')).toBeTruthy();
	});
});
