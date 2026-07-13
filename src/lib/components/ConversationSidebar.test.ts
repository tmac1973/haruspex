import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import ConversationSidebar from './ConversationSidebar.svelte';
import {
	clearAllConversations,
	deleteConversation,
	getConversations
} from '$lib/stores/chat.svelte';

// The real chat store pulls in Tauri IPC; the sidebar only needs the
// handful of functions it imports, so mock the whole module.
vi.mock('$lib/stores/chat.svelte', () => ({
	clearAllConversations: vi.fn(),
	createConversation: vi.fn(),
	deleteConversation: vi.fn(),
	getActiveConversationId: vi.fn(() => 'c1'),
	getConversations: vi.fn(),
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
