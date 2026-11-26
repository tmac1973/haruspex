import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import ConversationSidebar from './ConversationSidebar.svelte';
import { pickFromRowMenu, renderRowMenuHost } from '#lib/testing/rowMenu.ts';
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

// This computer's full-text search, and deleting another computer's chats.
vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore({
		db_search_conversations: (args) =>
			(args as { query: string }).query.startsWith('lentil') ? ['c2'] : []
	})
);
const remote = vi.hoisted(() => ({ deleteRemoteChat: vi.fn(async () => {}) }));
vi.mock('#lib/peers/remoteChat.svelte.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/peers/remoteChat.svelte.ts')>()),
	deleteRemoteChat: remote.deleteRemoteChat
}));

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
	renderRowMenuHost();
});

function row(title: string): HTMLElement {
	return screen.getByText(title).closest<HTMLElement>('.conversation-item')!;
}

async function deleteFromMenu(title: string) {
	await pickFromRowMenu(row(title), 'Delete…');
}

describe('ConversationSidebar delete confirmation', () => {
	it("the row menu's Delete opens the dialog without deleting", async () => {
		render(ConversationSidebar);
		await deleteFromMenu('First chat');
		screen.getByText('Delete conversation?');
		screen.getByText('"First chat" will be permanently deleted.');
		expect(deleteConversation).not.toHaveBeenCalled();
	});

	it('confirming deletes the right conversation and closes the dialog', async () => {
		render(ConversationSidebar);
		await deleteFromMenu('Second chat');
		await fireEvent.click(screen.getByText('Delete'));
		expect(deleteConversation).toHaveBeenCalledTimes(1);
		expect(deleteConversation).toHaveBeenCalledWith('c2');
		expect(screen.queryByText('Delete conversation?')).toBeNull();
	});

	it('cancelling leaves everything untouched', async () => {
		render(ConversationSidebar);
		await deleteFromMenu('First chat');
		await fireEvent.click(screen.getByText('Cancel'));
		expect(deleteConversation).not.toHaveBeenCalled();
		expect(screen.queryByText('Delete conversation?')).toBeNull();
	});

	it('Escape cancels without deleting', async () => {
		render(ConversationSidebar);
		await deleteFromMenu('First chat');
		await fireEvent.keyDown(window, { key: 'Escape' });
		expect(deleteConversation).not.toHaveBeenCalled();
		expect(screen.queryByText('Delete conversation?')).toBeNull();
	});

	it("clear-all goes through its own confirmation, for this computer's chats only", async () => {
		peers.list = [peerView('demogorgon')];
		render(ConversationSidebar);
		await fireEvent.click(screen.getByText('Clear all on this computer'));
		screen.getByText('Delete all conversations on this computer?');
		screen.getByText(/Your other computers' chats stay/);
		expect(clearAllConversations).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByText('Delete all'));
		expect(clearAllConversations).toHaveBeenCalledTimes(1);
		expect(remote.deleteRemoteChat).not.toHaveBeenCalled();
		expect(screen.queryByText('Delete all conversations on this computer?')).toBeNull();
	});
});

describe('ConversationSidebar rename affordance', () => {
	it("the row menu's Rename enters the inline rename state", async () => {
		render(ConversationSidebar);
		await pickFromRowMenu(row('First chat'), 'Rename');
		const input = screen.getByDisplayValue('First chat');
		expect(input).toBeTruthy();
		expect(renameConversation).not.toHaveBeenCalled();
	});

	it('a double-click rename commits on Enter', async () => {
		render(ConversationSidebar);
		await fireEvent.dblClick(row('Second chat'));
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

describe('ConversationSidebar search', () => {
	it('keeps chats by title as you type, and by what was said once typing settles', async () => {
		peers.list = [peerView('demogorgon')];
		render(ConversationSidebar);
		const box = screen.getByRole('searchbox', { name: 'Search chats' });

		await fireEvent.input(box, { target: { value: 'first' } });
		expect(screen.queryByText('First chat')).not.toBeNull();
		expect(screen.queryByText('Second chat')).toBeNull();
		// No match there: its section goes.
		expect(screen.queryByRole('region', { name: 'On demogorgon' })).toBeNull();

		await fireEvent.input(box, { target: { value: 'plans' } });
		screen.getByRole('region', { name: 'On demogorgon' });

		// Not in a title: the message search finds it.
		await fireEvent.input(box, { target: { value: 'lentil' } });
		await screen.findByText('Second chat');
		expect(screen.queryByText('First chat')).toBeNull();

		await fireEvent.input(box, { target: { value: 'nothing like it' } });
		await screen.findByText('No chats match.');
	});
});

describe('ConversationSidebar select', () => {
	it('picks a range with shift, and deletes them on each computer after asking', async () => {
		peers.list = [peerView('demogorgon')];
		render(ConversationSidebar);
		await fireEvent.click(screen.getByRole('button', { name: 'Select' }));
		// Rows have checkboxes now, and no row menu.
		await fireEvent.contextMenu(row('First chat'));
		expect(screen.queryByRole('menu')).toBeNull();

		await fireEvent.click(screen.getByLabelText('Select First chat'));
		await fireEvent.click(screen.getByLabelText('Select Plans on demogorgon'), { shiftKey: true });
		expect((screen.getByLabelText('Select Second chat') as HTMLInputElement).checked).toBe(true);

		await fireEvent.click(screen.getByRole('button', { name: 'Delete 3' }));
		screen.getByText('Delete 3 conversations?');
		screen.getByText('2 on this computer, 1 on demogorgon: permanently deleted.');
		await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		await vi.waitFor(() => expect(remote.deleteRemoteChat).toHaveBeenCalledTimes(1));
		expect(vi.mocked(deleteConversation).mock.calls.map((c) => c[0])).toEqual(['c1', 'c2']);
		expect((remote.deleteRemoteChat.mock.calls[0] as unknown[])[1]).toBe('demogorgon-1');
		// Back to the list.
		screen.getByText('Clear all on this computer');
	});

	it("can't select an offline computer's chats, and selects only what's shown", async () => {
		peers.list = [peerView('nas', false)];
		render(ConversationSidebar);
		await fireEvent.click(screen.getByRole('button', { name: 'Select' }));
		expect((screen.getByLabelText('Select Kept on nas') as HTMLInputElement).disabled).toBe(true);
		await fireEvent.click(screen.getByRole('button', { name: 'Select all shown' }));
		// This computer's two; the offline one's kept chat isn't among them.
		screen.getByRole('button', { name: 'Delete 2' });

		await fireEvent.input(screen.getByRole('searchbox', { name: 'Search chats' }), {
			target: { value: 'first' }
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Select all shown' }));
		screen.getByRole('button', { name: 'Delete 1' });
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(screen.queryByLabelText('Select First chat')).toBeNull();
	});
});

describe("ConversationSidebar: another computer's chat menu", () => {
	it('deletes it there after asking, and offers nothing for an offline one', async () => {
		peers.list = [peerView('demogorgon'), peerView('nas', false)];
		render(ConversationSidebar);
		await pickFromRowMenu(row('Plans on demogorgon'), 'Delete…');
		screen.getByText('"Plans on demogorgon" will be permanently deleted on demogorgon.');
		await fireEvent.click(screen.getByText('Delete'));
		expect(remote.deleteRemoteChat).toHaveBeenCalledWith(peers.list[0], 'demogorgon-1');

		await fireEvent.contextMenu(row('Kept on nas'));
		expect(screen.queryByRole('menu')).toBeNull();
	});
});
