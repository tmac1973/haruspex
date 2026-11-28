import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type {
	NotebookCard,
	NotebookDetail,
	NotebookSummary,
	NotebookTrash
} from '#lib/notebooks/api.ts';
import type { NotebookBackend } from '#lib/notebooks/backend.svelte.ts';
import type { EngineClient } from '#lib/engine/client.svelte.ts';
import type { LinkStatus } from '#lib/notebooks/links.ts';
import type { InvokeRoute } from '#lib/testing/invoke.ts';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

const sync = vi.hoisted(() => ({
	forwarded: [] as { notebookId: string; cardIds: string[] }[],
	fromOtherWindows: null as ((c: { notebookId: string; cardIds: string[] }) => void) | null
}));
vi.mock('#lib/notebooks/windowSync.ts', () => ({
	forwardToMain: (c: { notebookId: string; cardIds: string[] }) => sync.forwarded.push(c),
	listenForNotebookChanges: async (
		apply: (c: { notebookId: string; cardIds: string[] }) => void
	) => {
		sync.fromOtherWindows = apply;
		return () => {
			sync.fromOtherWindows = null;
		};
	}
}));

const settings = vi.hoisted(() => ({ proxy: null as unknown }));
vi.mock('#lib/stores/settings.ts', () => ({ getSettings: () => settings }));

type Store = typeof import('./notebooks.svelte.ts');
type Toasts = typeof import('#lib/stores/toasts.svelte.ts');

let store: Store;
let toasts: Toasts;
let invoke: Mock;

const RECENT = Date.now();

const summary = (id: string, over: Partial<NotebookSummary> = {}): NotebookSummary => ({
	id,
	title: id.toUpperCase(),
	pinned: false,
	tags: [],
	card_count: 0,
	created_at: 0,
	updated_at: 0,
	deleted_at: null,
	links_checked_at: RECENT,
	...over
});

const card = (id: string, over: Partial<NotebookCard> = {}): NotebookCard => ({
	id,
	notebook_id: 'a',
	position: 1,
	kind: 'text',
	title: '',
	body: '',
	meta: '{}',
	version: 1,
	source: '{"kind":"user"}',
	created_at: 0,
	updated_at: 0,
	deleted_at: null,
	row_count: 0,
	rows: [],
	...over
});

/** The fake database the routes answer from. */
let notebooks: Record<string, NotebookDetail>;
let trash: NotebookTrash;
let routes: Record<string, InvokeRoute>;

function addNotebook(s: NotebookSummary, cards: NotebookCard[] = []): void {
	notebooks[s.id] = { notebook: s, cards };
}

const get = (id: string) => {
	const nb = notebooks[id];
	if (!nb) throw 'no such notebook';
	return structuredClone(nb);
};

function baseRoutes(): Record<string, InvokeRoute> {
	return {
		notebook_list: () => Object.values(notebooks).map((n) => structuredClone(n.notebook)),
		notebook_get: (a) => get(a!.id as string),
		notebook_link_status_get: [],
		notebook_trash_list: () => structuredClone(trash),
		notebook_update: (a) => {
			const nb = notebooks[a!.id as string].notebook;
			if (a!.title !== null) nb.title = a!.title as string;
			if (a!.pinned !== null) nb.pinned = a!.pinned as boolean;
			if (a!.tags !== null) nb.tags = a!.tags as string[];
			return structuredClone(nb);
		},
		notebook_delete: (a) => {
			const id = a!.id as string;
			trash.notebooks.push(notebooks[id].notebook);
			delete notebooks[id];
			return null;
		},
		notebook_restore: (a) => {
			const i = trash.notebooks.findIndex((n) => n.id === a!.id);
			const [nb] = trash.notebooks.splice(i, 1);
			notebooks[nb.id] = { notebook: nb, cards: [] };
			return null;
		},
		notebook_purge: (a) => {
			trash.notebooks = trash.notebooks.filter((n) => n.id !== a!.id);
			return null;
		},
		notebook_card_delete: (a) => {
			for (const nb of Object.values(notebooks)) {
				const c = nb.cards.find((x) => x.id === a!.cardId);
				if (!c) continue;
				nb.cards = nb.cards.filter((x) => x !== c);
				trash.cards.push({ card: c, notebook_title: nb.notebook.title });
			}
			return null;
		},
		notebook_card_restore: (a) => {
			const i = trash.cards.findIndex((t) => t.card.id === a!.cardId);
			const [t] = trash.cards.splice(i, 1);
			notebooks[t.card.notebook_id].cards.push(t.card);
			return null;
		},
		notebook_card_purge: (a) => {
			trash.cards = trash.cards.filter((t) => t.card.id !== a!.cardId);
			return null;
		}
	};
}

/** The args of every `cmd` sent so far. */
const sent = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd).map((c) => c[1]);

const messages = () => toasts.getToasts().map((t) => ({ kind: t.kind, message: t.message }));

/** Let the store's fire-and-forget work (link status, list reload) settle. */
const settle = () => vi.waitFor(() => expect(store.isCheckingLinks()).toBe(false));

beforeEach(async () => {
	vi.resetModules();
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	settings.proxy = null;
	sync.forwarded = [];
	sync.fromOtherWindows = null;
	notebooks = {};
	trash = { notebooks: [], cards: [] };
	routes = baseRoutes();
	const { invokeRouter, unexpectedInvoke } = await import('#lib/testing/invoke.ts');
	invoke = vi.mocked((await import('@tauri-apps/api/core')).invoke) as unknown as Mock;
	invoke.mockImplementation((cmd: string, args?: unknown) =>
		invokeRouter(routes, unexpectedInvoke)(cmd, args as Record<string, unknown>)
	);
	store = await import('./notebooks.svelte.ts');
	toasts = await import('#lib/stores/toasts.svelte.ts');
});

/** A notebook on another computer, and a client whose events the test fires. */
function peer(details: Record<string, NotebookDetail>) {
	const listeners = new Set<(id: string) => void>();
	const be: NotebookBackend = {
		kind: 'peer',
		peerId: 'p1',
		peerName: 'Laptop',
		can: { arrange: false, meta: false, preview: false, trash: false },
		get: async (id) => {
			if (!details[id]) throw new Error('gone');
			return structuredClone(details[id]);
		}
	} as NotebookBackend;
	const client = {
		onNotebookChanged: (cb: (id: string) => void) => {
			listeners.add(cb);
			return () => listeners.delete(cb);
		}
	} as unknown as EngineClient;
	return { be, client, listeners, fire: (id: string) => listeners.forEach((l) => l(id)) };
}

describe('opening a notebook', () => {
	it('shows the stored notebook, focuses the card asked for, and loads the list', async () => {
		addNotebook(summary('a'), [card('c1')]);
		expect(await store.openNotebook('a', 'c1', 'r9')).toBe(true);
		expect(store.getOpenNotebookId()).toBe('a');
		expect(store.getOpenNotebook()?.cards.map((c) => c.id)).toEqual(['c1']);
		expect(store.getFocusCard()).toMatchObject({ id: 'c1', rowId: 'r9' });
		expect(store.getOpenBackend().kind).toBe('local');
		await vi.waitFor(() => expect(store.isNotebookListLoaded()).toBe(true));
		expect(store.getNotebookList().map((n) => n.id)).toEqual(['a']);
		expect(sent('notebook_get')).toEqual([{ id: 'a' }]);
	});

	it('clears the focused card when none is asked for', async () => {
		addNotebook(summary('a'), [card('c1')]);
		addNotebook(summary('b'));
		await store.openNotebook('a', 'c1');
		await store.openNotebook('b');
		expect(store.getFocusCard()).toBeNull();
	});

	it('hides Trash when a notebook opens', async () => {
		addNotebook(summary('a'));
		await store.openTrash();
		expect(store.isTrashShown()).toBe(true);
		await store.openNotebook('a');
		expect(store.isTrashShown()).toBe(false);
	});

	it('says the notebook was deleted when it cannot be read', async () => {
		expect(await store.openNotebook('gone')).toBe(false);
		expect(store.getOpenNotebook()).toBeNull();
		expect(store.getOpenNotebookId()).toBeNull();
		expect(messages()).toEqual([{ kind: 'error', message: 'That notebook was deleted.' }]);
	});

	it('reads the last link verdicts for a notebook on this computer', async () => {
		const kept: LinkStatus = { url: 'https://a.com', state: 'broken', status: '404' };
		routes.notebook_link_status_get = [kept];
		addNotebook(summary('a'), [card('c1', { body: '[A](https://a.com)' })]);
		await store.openNotebook('a');
		await vi.waitFor(() => expect(store.getLinkStatus('https://a.com')).toEqual(kept));
		expect(sent('notebook_link_status_get')).toEqual([{ notebookId: 'a' }]);
	});

	it('checks the links quietly when they were never checked', async () => {
		routes.notebook_links_check = (a) =>
			(a!.urls as string[]).map((url) => ({ url, state: 'broken', status: '404' }));
		addNotebook(summary('a', { links_checked_at: null }), [
			card('c1', { body: '[A](https://a.com)' })
		]);
		await store.openNotebook('a');
		await vi.waitFor(() => expect(store.getLinkStatus('https://a.com')?.state).toBe('broken'));
		await settle();
		expect(messages()).toContainEqual({ kind: 'info', message: '1 broken link.' });
	});

	describe('on a paired computer', () => {
		it('opens through that backend and never reads link verdicts', async () => {
			const p = peer({ x: { notebook: summary('x'), cards: [card('c1')] } });
			expect(await store.openNotebookOn(p.be, 'x', undefined, undefined, p.client)).toBe(true);
			expect(store.getOpenBackend()).toBe(p.be);
			expect(store.getOpenNotebook()?.notebook.id).toBe('x');
			expect(store.getLinkStatuses()).toEqual({});
			expect(sent('notebook_get')).toEqual([]);
			expect(sent('notebook_link_status_get')).toEqual([]);
		});

		it('re-reads the open notebook when that computer says it changed', async () => {
			const details = { x: { notebook: summary('x'), cards: [card('c1')] } };
			const p = peer(details);
			await store.openNotebookOn(p.be, 'x', undefined, undefined, p.client);
			details.x.cards = [card('c1'), card('c2')];
			p.fire('other');
			p.fire('x');
			await vi.waitFor(() =>
				expect(store.getOpenNotebook()?.cards.map((c) => c.id)).toEqual(['c1', 'c2'])
			);
		});

		it('stops listening when the notebook closes or another opens', async () => {
			const p = peer({ x: { notebook: summary('x'), cards: [] } });
			await store.openNotebookOn(p.be, 'x', undefined, undefined, p.client);
			expect(p.listeners.size).toBe(1);
			store.closeNotebook();
			expect(p.listeners.size).toBe(0);
			expect(store.getOpenBackend().kind).toBe('local');

			addNotebook(summary('a'));
			await store.openNotebookOn(p.be, 'x', undefined, undefined, p.client);
			await store.openNotebook('a');
			expect(p.listeners.size).toBe(0);
			expect(store.getOpenBackend().kind).toBe('local');
		});
	});

	// Open A (slow), then B (fast): A's read landing last must not put A on
	// the screen while openId says B.
	it('keeps the later notebook when an earlier open resolves last', async () => {
		addNotebook(summary('a'));
		addNotebook(summary('b'));
		const slow = Promise.withResolvers<NotebookDetail>();
		routes.notebook_get = (a) => (a!.id === 'a' ? slow.promise : get(a!.id as string));
		const first = store.openNotebook('a');
		await store.openNotebook('b');
		slow.resolve(get('a'));
		await first;
		expect(store.getOpenNotebookId()).toBe('b');
		expect(store.getOpenNotebook()?.notebook.id).toBe('b');
	});
});

describe('checking links', () => {
	const linked = () =>
		addNotebook(summary('a'), [
			card('c1', { body: '[A](https://a.com) and https://b.com' }),
			card('c2', { body: 'no links' })
		]);

	it('does nothing with no notebook open', async () => {
		await store.checkOpenLinks();
		expect(sent('notebook_links_check')).toEqual([]);
		expect(messages()).toEqual([]);
	});

	it('says so when the notebook has no links, unless quiet', async () => {
		addNotebook(summary('a'), [card('c1', { body: 'plain' })]);
		await store.openNotebook('a');
		await store.checkOpenLinks(true);
		expect(messages()).toEqual([]);
		await store.checkOpenLinks();
		expect(messages()).toEqual([{ kind: 'info', message: 'This notebook has no web links.' }]);
		expect(sent('notebook_links_check')).toEqual([]);
	});

	it('sends the links with the proxy and keeps the verdicts by URL', async () => {
		settings.proxy = { url: 'http://proxy:8080' };
		routes.notebook_links_check = (a) =>
			(a!.urls as string[]).map((url) => ({
				url,
				state: url.includes('b.com') ? 'broken' : 'ok',
				status: url.includes('b.com') ? '404' : '200'
			}));
		linked();
		await store.openNotebook('a');
		await settle();
		await store.checkOpenLinks();
		expect(sent('notebook_links_check')).toEqual([
			{
				notebookId: 'a',
				urls: ['https://a.com', 'https://b.com'],
				proxy: { url: 'http://proxy:8080' }
			}
		]);
		expect(store.getLinkStatuses()).toEqual({
			'https://a.com': { url: 'https://a.com', state: 'ok', status: '200' },
			'https://b.com': { url: 'https://b.com', state: 'broken', status: '404' }
		});
		expect(messages()).toEqual([{ kind: 'info', message: '1 broken link.' }]);
	});

	it('counts broken links in the plural, and says when every link works', async () => {
		let state = 'broken';
		routes.notebook_links_check = (a) =>
			(a!.urls as string[]).map((url) => ({ url, state, status: '' }));
		linked();
		await store.openNotebook('a');
		await settle();
		await store.checkOpenLinks();
		state = 'ok';
		await store.checkOpenLinks();
		expect(messages()).toEqual([
			{ kind: 'info', message: '2 broken links.' },
			{ kind: 'success', message: 'Every link works.' }
		]);
	});

	it('stays quiet when asked to and every link works', async () => {
		routes.notebook_links_check = (a) =>
			(a!.urls as string[]).map((url) => ({ url, state: 'ok', status: '200' }));
		linked();
		await store.openNotebook('a');
		await settle();
		await store.checkOpenLinks(true);
		expect(store.getLinkStatus('https://a.com')?.state).toBe('ok');
		expect(messages()).toEqual([]);
	});

	it('shows it is checking, and ignores a second check meanwhile', async () => {
		const pending = Promise.withResolvers<LinkStatus[]>();
		routes.notebook_links_check = () => pending.promise;
		linked();
		await store.openNotebook('a');
		await settle();
		const first = store.checkOpenLinks();
		expect(store.isCheckingLinks()).toBe(true);
		await store.checkOpenLinks();
		expect(sent('notebook_links_check')).toHaveLength(1);
		pending.resolve([]);
		await first;
		expect(store.isCheckingLinks()).toBe(false);
	});

	it('drops the verdicts when another notebook opened meanwhile', async () => {
		const pending = Promise.withResolvers<LinkStatus[]>();
		routes.notebook_links_check = () => pending.promise;
		linked();
		addNotebook(summary('b'));
		await store.openNotebook('a');
		await settle();
		const check = store.checkOpenLinks();
		await store.openNotebook('b');
		pending.resolve([{ url: 'https://a.com', state: 'broken', status: '404' }]);
		await check;
		expect(store.getLinkStatuses()).toEqual({});
		expect(messages()).toEqual([]);
	});

	it('reports a failed check, or only logs it when quiet', async () => {
		routes.notebook_links_check = () => {
			throw 'offline';
		};
		linked();
		await store.openNotebook('a');
		await settle();
		await store.checkOpenLinks(true);
		expect(messages()).toEqual([]);
		expect(store.isCheckingLinks()).toBe(false);
		await store.checkOpenLinks();
		expect(messages()).toEqual([{ kind: 'error', message: 'Checking links failed: offline' }]);
		expect(store.isCheckingLinks()).toBe(false);
	});

	it("never checks another computer's notebook", async () => {
		const p = peer({
			x: { notebook: summary('x'), cards: [card('c1', { body: 'https://a.com' })] }
		});
		await store.openNotebookOn(p.be, 'x');
		await store.checkOpenLinks();
		expect(sent('notebook_links_check')).toEqual([]);
		expect(messages()).toEqual([]);
	});
});

describe('changing a notebook', () => {
	it('sends only the fields given, then shows the list and open notebook as stored', async () => {
		addNotebook(summary('a'));
		await store.openNotebook('a');
		await store.patchNotebook('a', { title: 'Renamed' });
		expect(sent('notebook_update')).toEqual([
			{ id: 'a', title: 'Renamed', pinned: null, tags: null }
		]);
		expect(store.getNotebookList().map((n) => n.title)).toEqual(['Renamed']);
		expect(store.getOpenNotebook()?.notebook.title).toBe('Renamed');
	});

	it('updates a notebook that is not open in the list only', async () => {
		addNotebook(summary('a'));
		addNotebook(summary('b'));
		await store.openNotebook('a');
		await store.patchNotebook('b', { pinned: true, tags: ['work'] });
		expect(sent('notebook_update')).toEqual([
			{ id: 'b', title: null, pinned: true, tags: ['work'] }
		]);
		expect(store.getNotebookList().find((n) => n.id === 'b')).toMatchObject({
			pinned: true,
			tags: ['work']
		});
		expect(store.getOpenNotebook()?.notebook.id).toBe('a');
	});

	it("refuses to rename another computer's open notebook", async () => {
		const p = peer({ x: { notebook: summary('x'), cards: [] } });
		await store.openNotebookOn(p.be, 'x');
		await store.patchNotebook('x', { title: 'Nope' });
		expect(sent('notebook_update')).toEqual([]);
		expect(messages()).toEqual([{ kind: 'info', message: 'Change this on Laptop.' }]);
	});

	it('reports a failed save and keeps the list as it was', async () => {
		addNotebook(summary('a'));
		await store.loadNotebookList();
		routes.notebook_update = () => {
			throw new Error('disk full');
		};
		await store.patchNotebook('a', { title: 'Renamed' });
		expect(store.getNotebookList().map((n) => n.title)).toEqual(['A']);
		expect(messages()).toEqual([
			{ kind: 'error', message: 'Saving the notebook failed: disk full' }
		]);
	});

	it('reports a list that cannot be loaded', async () => {
		routes.notebook_list = () => {
			throw 'locked';
		};
		await store.loadNotebookList();
		expect(store.isNotebookListLoaded()).toBe(false);
		expect(messages()).toEqual([{ kind: 'error', message: 'Loading notebooks failed: locked' }]);
	});
});

describe('tags', () => {
	it('keeps the tag filter', () => {
		expect(store.getTagFilter()).toBeNull();
		store.setTagFilter('work');
		expect(store.getTagFilter()).toBe('work');
		store.setTagFilter(null);
		expect(store.getTagFilter()).toBeNull();
	});

	it('lists every tag in use once, sorted', async () => {
		addNotebook(summary('a', { tags: ['work', 'Books'] }));
		addNotebook(summary('b', { tags: ['books', 'work'] }));
		addNotebook(summary('c'));
		await store.loadNotebookList();
		expect(store.allTags()).toEqual(['books', 'Books', 'work']);
	});
});

describe('Trash', () => {
	it('opening Trash closes the open notebook and shows what is in it', async () => {
		addNotebook(summary('a'));
		trash.notebooks = [summary('old', { deleted_at: 5 })];
		await store.openNotebook('a');
		await store.openTrash();
		expect(store.isTrashShown()).toBe(true);
		expect(store.getOpenNotebook()).toBeNull();
		expect(store.getTrash().notebooks.map((n) => n.id)).toEqual(['old']);
		store.closeTrash();
		expect(store.isTrashShown()).toBe(false);
	});

	it('keeps what it showed when Trash cannot be read', async () => {
		trash.notebooks = [summary('old')];
		await store.openTrash();
		routes.notebook_trash_list = () => {
			throw 'busy';
		};
		await store.loadTrash();
		expect(store.getTrash().notebooks.map((n) => n.id)).toEqual(['old']);
		expect(messages()).toEqual([{ kind: 'error', message: 'Loading Trash failed: busy' }]);
	});

	it('trashing the open notebook closes it, and Undo puts it back', async () => {
		addNotebook(summary('a'));
		addNotebook(summary('b'));
		await store.openNotebook('a');
		await store.trashNotebook('a');
		expect(sent('notebook_delete')).toEqual([{ id: 'a' }]);
		expect(store.getOpenNotebook()).toBeNull();
		expect(store.getNotebookList().map((n) => n.id)).toEqual(['b']);
		const toast = toasts.getToasts()[0];
		expect(toast).toMatchObject({ message: 'Moved to Trash.', actionLabel: 'Undo' });
		toast.onAction!();
		await vi.waitFor(() => expect(store.getNotebookList().map((n) => n.id)).toEqual(['b', 'a']));
		expect(sent('notebook_restore')).toEqual([{ id: 'a' }]);
	});

	it("refuses to trash another computer's open notebook", async () => {
		const p = peer({ x: { notebook: summary('x'), cards: [] } });
		await store.openNotebookOn(p.be, 'x');
		await store.trashNotebook('x');
		expect(sent('notebook_delete')).toEqual([]);
		expect(store.getOpenNotebook()?.notebook.id).toBe('x');
		expect(messages()).toEqual([{ kind: 'info', message: 'Change this on Laptop.' }]);
	});

	it('reports a notebook that cannot be trashed', async () => {
		addNotebook(summary('a'));
		await store.openNotebook('a');
		routes.notebook_delete = () => {
			throw 'locked';
		};
		await store.trashNotebook('a');
		expect(store.getOpenNotebook()?.notebook.id).toBe('a');
		expect(messages()).toEqual([
			{ kind: 'error', message: 'Deleting the notebook failed: locked' }
		]);
	});

	it('restoring from the Trash view refreshes it and the list', async () => {
		trash.notebooks = [summary('old')];
		await store.openTrash();
		await store.restoreNotebookFromTrash('old');
		expect(store.getTrash().notebooks).toEqual([]);
		expect(store.getNotebookList().map((n) => n.id)).toEqual(['old']);
	});

	it('reports a restore that fails', async () => {
		routes.notebook_restore = () => {
			throw 'gone';
		};
		await store.restoreNotebookFromTrash('old');
		expect(messages()).toEqual([{ kind: 'error', message: 'Restoring the notebook failed: gone' }]);
	});

	it('emptying a notebook from Trash removes it from the view', async () => {
		trash.notebooks = [summary('old'), summary('older')];
		await store.openTrash();
		await store.purgeNotebookForGood('old');
		expect(sent('notebook_purge')).toEqual([{ id: 'old' }]);
		expect(store.getTrash().notebooks.map((n) => n.id)).toEqual(['older']);
	});

	it('trashing a card re-reads the notebook, and Undo puts the card back', async () => {
		addNotebook(summary('a'), [card('c1'), card('c2')]);
		await store.openNotebook('a');
		await store.trashCard('c1');
		expect(sent('notebook_card_delete')).toEqual([{ cardId: 'c1' }]);
		expect(store.getOpenNotebook()?.cards.map((c) => c.id)).toEqual(['c2']);
		const toast = toasts.getToasts()[0];
		expect(toast).toMatchObject({ message: 'Card moved to Trash.', actionLabel: 'Undo' });
		toast.onAction!();
		await vi.waitFor(() =>
			expect(store.getOpenNotebook()?.cards.map((c) => c.id)).toEqual(['c2', 'c1'])
		);
		expect(sent('notebook_card_restore')).toEqual([{ cardId: 'c1' }]);
	});

	it('emptying a card from Trash removes it from the view', async () => {
		trash.cards = [{ card: card('c1'), notebook_title: 'A' }];
		await store.openTrash();
		await store.purgeCardForGood('c1');
		expect(sent('notebook_card_purge')).toEqual([{ cardId: 'c1' }]);
		expect(store.getTrash().cards).toEqual([]);
	});

	it('reports a card that cannot be emptied from Trash', async () => {
		routes.notebook_card_purge = () => {
			throw 'locked';
		};
		await store.purgeCardForGood('c1');
		expect(messages()).toEqual([{ kind: 'error', message: 'Deleting the card failed: locked' }]);
	});

	it('reading everything again refreshes the list, open notebook and Trash', async () => {
		addNotebook(summary('a'), [card('c1')]);
		await store.openNotebook('a');
		await settle();
		notebooks.a.cards.push(card('c2'));
		addNotebook(summary('b'));
		await store.reloadAllNotebooks();
		expect(store.getNotebookList().map((n) => n.id)).toEqual(['a', 'b']);
		expect(store.getOpenNotebook()?.cards.map((c) => c.id)).toEqual(['c1', 'c2']);
	});
});

describe('changes from elsewhere', () => {
	it('refresh the open notebook and the list, and tell listeners', async () => {
		addNotebook(summary('a'), [card('c1')]);
		await store.openNotebook('a');
		await vi.waitFor(() => expect(store.isNotebookListLoaded()).toBe(true));
		const heard: [string, string[]][] = [];
		const off = store.onNotebookChanged((id, cards) => heard.push([id, cards]));
		notebooks.a.cards.push(card('c2'));
		addNotebook(summary('b'));
		store.emitNotebookChanged('a', ['c2']);
		await vi.waitFor(() =>
			expect(store.getOpenNotebook()?.cards.map((c) => c.id)).toEqual(['c1', 'c2'])
		);
		await vi.waitFor(() => expect(store.getNotebookList()).toHaveLength(2));
		expect(heard).toEqual([['a', ['c2']]]);
		expect(sync.forwarded).toEqual([{ notebookId: 'a', cardIds: ['c2'] }]);
		off();
		store.emitNotebookChanged('a');
		expect(heard).toHaveLength(1);
	});

	it('a listener that throws does not stop the others', () => {
		const heard: string[] = [];
		store.onNotebookChanged(() => {
			throw new Error('bad listener');
		});
		store.onNotebookChanged((id) => heard.push(id));
		store.emitNotebookChanged('a');
		expect(heard).toEqual(['a']);
	});

	it('the main window applies changes other windows pass on', async () => {
		const heard: string[] = [];
		store.onNotebookChanged((id) => heard.push(id));
		const stop = await store.listenForOtherWindowsNotebookChanges();
		sync.fromOtherWindows!({ notebookId: 'z', cardIds: [] });
		expect(heard).toEqual(['z']);
		expect(sync.forwarded).toEqual([]);
		stop();
	});
});

describe('cards', () => {
	it('a card that changed elsewhere is re-read, and the user told', async () => {
		addNotebook(summary('a'), [card('c1', { body: 'old' })]);
		await store.openNotebook('a');
		notebooks.a.cards[0] = card('c1', { body: 'theirs', version: 2 });
		routes.notebook_card_update = () => {
			throw 'conflict';
		};
		const saved = await store.saveCard(store.getOpenNotebook()!.cards[0], { body: 'mine' });
		expect(saved).toBeNull();
		expect(store.getOpenNotebook()?.cards[0].body).toBe('theirs');
		expect(messages()).toEqual([
			{ kind: 'info', message: 'This card changed elsewhere — reloaded.' }
		]);
	});

	it('a saved card replaces the one shown', async () => {
		addNotebook(summary('a'), [card('c1', { body: 'old' })]);
		await store.openNotebook('a');
		routes.notebook_card_update = (a) => card('c1', { body: a!.body as string, version: 2 });
		const saved = await store.saveCard(store.getOpenNotebook()!.cards[0], { body: 'new' });
		expect(saved?.version).toBe(2);
		expect(sent('notebook_card_update')).toEqual([
			{
				cardId: 'c1',
				expectedVersion: 1,
				title: null,
				body: 'new',
				meta: null,
				source: '{"kind":"user"}'
			}
		]);
		expect(store.getOpenNotebook()?.cards[0].body).toBe('new');
	});

	it('nudging a card moves it after the right neighbour', async () => {
		routes.notebook_card_move = null;
		addNotebook(summary('a'), [card('c1'), card('c2'), card('c3')]);
		await store.openNotebook('a');
		await store.nudgeCard('c3', -1);
		await store.nudgeCard('c2', -1);
		await store.nudgeCard('c1', 1);
		await store.nudgeCard('c1', -1);
		expect(sent('notebook_card_move')).toEqual([
			{ cardId: 'c3', afterCardId: 'c1' },
			{ cardId: 'c2', afterCardId: null },
			{ cardId: 'c1', afterCardId: 'c2' }
		]);
	});
});
