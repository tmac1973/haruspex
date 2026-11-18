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
	setActiveConversation: vi.fn(),
	// The Chat view's source while this computer's chats show.
	localChatSource: { capabilities: {} }
}));

// Other computers, as the sidebar reads them: live lists, or kept ones while offline.
const peers = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('#lib/peers/store.svelte.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/peers/store.svelte.ts')>()),
	peerViews: () => peers.list
}));

function peerView(name: string, online = true) {
	return {
		id: name,
		config: { name },
		online,
		client: {
			lean: false,
			prompts: {},
			chats: [
				{
					id: `${name}-1`,
					title: `Plans on ${name}`,
					updatedAt: 1,
					open: false,
					busy: true,
					waiting: false,
					unread: false
				}
			]
		},
		lastKnown: {
			sessions: [],
			chats: [{ id: `${name}-old`, title: `Kept on ${name}`, updatedAt: 1 }],
			updatedAt: 1
		}
	};
}

// The sidebar only reads id + title off each conversation.
const conversations = [
	{ id: 'c1', title: 'First chat' },
	{ id: 'c2', title: 'Second chat' }
];

beforeEach(() => {
	vi.clearAllMocks();
	peers.list = [];
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
		screen.getByText('Delete conversation?');
		screen.getByText('"First chat" will be permanently deleted.');
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
		screen.getByText('Delete all conversations?');
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
		screen.getByLabelText('Finished while you were elsewhere');
	});
});

describe("ConversationSidebar: other computers' chats", () => {
	it('lists each under its name, marked as the web page marks them, greyed while offline', () => {
		peers.list = [peerView('desk-pc'), peerView('nas', false)];
		render(ConversationSidebar);
		const desk = screen.getByRole('region', { name: 'On desk-pc' });
		expect(desk.textContent).toContain('Plans on desk-pc');
		expect(desk.querySelector('[data-mark="running"]')).not.toBeNull();
		const nas = screen.getByRole('region', { name: 'On nas' });
		expect(nas.textContent).toContain('· offline');
		const kept = [...nas.querySelectorAll('.conversation-item')];
		expect(kept.map((r) => r.textContent?.trim())).toEqual(['Kept on nas']);
		expect(kept[0].classList.contains('offline')).toBe(true);
	});
});
