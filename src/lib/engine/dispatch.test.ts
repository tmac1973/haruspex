/**
 * `dispatch` against fake sessions: which window answers what, how the
 * session list merges open and saved sessions, and how much of a file
 * `session.readFile` sends. The engine end to end is in `engine.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invokeCalls, invokeRouter } from '#lib/testing/invoke.ts';
import type { EngineOp } from './types';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	open: [] as Array<Record<string, unknown>>,
	saved: [] as Array<Record<string, unknown>>,
	openSession: vi.fn(),
	newSession: vi.fn(),
	dispatchChat: vi.fn(),
	answerPrompt: vi.fn(),
	currentPrompts: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('#lib/stores/code.svelte.ts', () => ({
	getOpenSessions: () => mocks.open,
	openSession: mocks.openSession,
	newSession: mocks.newSession
}));
vi.mock('#lib/code/db.ts', () => ({
	listCodeSessions: async () => mocks.saved,
	wslDistros: async () => ['Ubuntu']
}));
vi.mock('#lib/engine/state.ts', () => ({
	sessionState: (s: { id: string }) => ({ state: s.id })
}));
vi.mock('#lib/engine/prompts.svelte.ts', () => ({
	answerPrompt: mocks.answerPrompt,
	currentPrompts: mocks.currentPrompts
}));
vi.mock('#lib/engine/chat.svelte.ts', () => ({ dispatchChat: mocks.dispatchChat }));
vi.mock('#lib/debug-log.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/debug-log.ts')>()),
	logDebug: () => {}
}));

import { dispatch, MAX_FILE_CHARS, MAIN_WINDOW, setChatResync, setResync } from './dispatch';

interface FakeSession {
	id: string;
	title: string;
	root: string;
	wslDistro: string | null;
	status: string;
	busy: boolean;
	folderMissing: boolean;
	shellWait: unknown;
	sent: string[];
	stopped: number;
	cancelledWait: number;
	compacted: string[];
	compactable: boolean;
	send(text: string, opts: { remote: boolean }): Promise<void>;
	stop(): void;
	cancelShellWait(): void;
	canCompact(): boolean;
	compactNow(instructions: string): Promise<void>;
}

function session(id: string, over: Partial<FakeSession> = {}): FakeSession {
	const s: FakeSession = {
		id,
		title: `title ${id}`,
		root: `/proj/${id}`,
		wslDistro: null,
		status: 'idle',
		busy: false,
		folderMissing: false,
		shellWait: null,
		sent: [],
		stopped: 0,
		cancelledWait: 0,
		compacted: [],
		compactable: true,
		send: async (text) => void s.sent.push(text),
		stop: () => void s.stopped++,
		cancelShellWait: () => void s.cancelledWait++,
		canCompact: () => s.compactable,
		compactNow: async (i) => void s.compacted.push(i),
		...over
	};
	return s;
}

const op = (o: EngineOp) => o;

beforeEach(() => {
	mocks.open = [];
	mocks.saved = [];
	mocks.invoke.mockReset();
	mocks.openSession.mockReset();
	mocks.newSession.mockReset();
	mocks.dispatchChat.mockReset();
	mocks.answerPrompt.mockReset();
	mocks.currentPrompts.mockReset();
	setResync(() => false);
	setChatResync(() => false);
});

describe('dispatch: sessions', () => {
	it('lists open sessions first, then saved ones open nowhere, from the main window', async () => {
		mocks.open = [session('a') as unknown as Record<string, unknown>];
		mocks.saved = [
			{ id: 'a', title: 'stale a', root: '/proj/a' },
			{ id: 'b', title: 'saved b', root: '/home/b', wsl_distro: 'Ubuntu' },
			{ id: 'c', title: 'saved c', root: '/c' }
		];
		expect(await dispatch(op({ type: 'sessions.list' }), MAIN_WINDOW)).toEqual([
			{
				id: 'a',
				title: 'title a',
				root: '/proj/a',
				wslDistro: null,
				status: 'idle',
				window: 'main'
			},
			{
				id: 'b',
				title: 'saved b',
				root: '/home/b',
				wslDistro: 'Ubuntu',
				status: null,
				window: null
			},
			{ id: 'c', title: 'saved c', root: '/c', wslDistro: null, status: null, window: null }
		]);
	});

	it('lists only its own open sessions from another window', async () => {
		mocks.open = [session('x') as unknown as Record<string, unknown>];
		mocks.saved = [{ id: 'y', title: 'y', root: '/y' }];
		const list = (await dispatch(op({ type: 'sessions.list' }), 'code-2')) as Array<{
			id: string;
			window: string;
		}>;
		expect(list.map((s) => [s.id, s.window])).toEqual([['x', 'code-2']]);
	});

	it('refuses an operation on a session not open in this window', async () => {
		await expect(dispatch(op({ type: 'session.get', id: 'nope' }), MAIN_WINDOW)).rejects.toThrow(
			'session nope is not open: open it first (session.open)'
		);
	});

	it('gets the state of an open session', async () => {
		mocks.open = [session('a') as unknown as Record<string, unknown>];
		expect(await dispatch(op({ type: 'session.get', id: 'a' }), 'w')).toEqual({ state: 'a' });
	});

	it('opens a session here, or reports it is in front elsewhere', async () => {
		mocks.openSession.mockResolvedValueOnce(session('a'));
		expect(await dispatch(op({ type: 'session.open', id: 'a' }), 'w1')).toEqual({
			id: 'a',
			window: 'w1'
		});
		mocks.openSession.mockResolvedValueOnce(null);
		expect(await dispatch(op({ type: 'session.open', id: 'b' }), 'w1')).toEqual({
			id: 'b',
			window: null
		});
	});

	it('makes a new session, defaulting effort and distro to null', async () => {
		mocks.newSession.mockImplementation(async (root: string, o: Record<string, unknown>) =>
			session('n', { root, wslDistro: (o.wslDistro as string) ?? null })
		);
		expect(await dispatch(op({ type: 'session.new', root: '/r' }), 'w')).toEqual({
			id: 'n',
			root: '/r',
			wslDistro: null,
			window: 'w'
		});
		expect(mocks.newSession.mock.calls[0]).toEqual(['/r', { effort: null, wslDistro: null }]);
	});

	it('lists WSL distros', async () => {
		expect(await dispatch(op({ type: 'wsl.distros' }), 'w')).toEqual(['Ubuntu']);
	});
});

describe('dispatch: turns', () => {
	it('starts a turn, or steers one already running', async () => {
		const s = session('a');
		mocks.open = [s as unknown as Record<string, unknown>];
		expect(await dispatch(op({ type: 'session.send', id: 'a', text: 'go' }), 'w')).toEqual({
			started: true
		});
		s.busy = true;
		expect(await dispatch(op({ type: 'session.send', id: 'a', text: 'also' }), 'w')).toEqual({
			steered: true
		});
		expect(s.sent).toEqual(['go', 'also']);
	});

	it('answers at once even when the turn later fails', async () => {
		const s = session('a', { send: () => Promise.reject(new Error('model down')) });
		mocks.open = [s as unknown as Record<string, unknown>];
		expect(await dispatch(op({ type: 'session.send', id: 'a', text: 'go' }), 'w')).toEqual({
			started: true
		});
	});

	it('refuses blank text and a session whose folder is gone', async () => {
		mocks.open = [
			session('a') as unknown as Record<string, unknown>,
			session('b', { folderMissing: true }) as unknown as Record<string, unknown>
		];
		await expect(
			dispatch(op({ type: 'session.send', id: 'a', text: '  \n' }), 'w')
		).rejects.toThrow('nothing to send');
		await expect(dispatch(op({ type: 'session.send', id: 'b', text: 'hi' }), 'w')).rejects.toThrow(
			"the session's folder is missing: /proj/b"
		);
	});

	it('compacts an idle session, and says when there is nothing to summarise', async () => {
		const s = session('a');
		mocks.open = [s as unknown as Record<string, unknown>];
		expect(await dispatch(op({ type: 'session.compact', id: 'a' }), 'w')).toEqual({
			started: true
		});
		expect(s.compacted).toEqual(['']);
		s.compactable = false;
		expect(await dispatch(op({ type: 'session.compact', id: 'a' }), 'w')).toEqual({
			started: false,
			reason: 'nothing to summarise yet'
		});
		s.busy = true;
		await expect(dispatch(op({ type: 'session.compact', id: 'a' }), 'w')).rejects.toThrow('busy');
	});

	it('stops a session and says whether a turn was running', async () => {
		const s = session('a');
		mocks.open = [s as unknown as Record<string, unknown>];
		expect(await dispatch(op({ type: 'session.stop', id: 'a' }), 'w')).toEqual({ stopping: false });
		s.busy = true;
		expect(await dispatch(op({ type: 'session.stop', id: 'a' }), 'w')).toEqual({ stopping: true });
		expect(s.stopped).toBe(2);
	});

	it('cancels a shell wait and says whether there was one', async () => {
		const s = session('a');
		mocks.open = [s as unknown as Record<string, unknown>];
		expect(await dispatch(op({ type: 'session.cancelShellWait', id: 'a' }), 'w')).toEqual({
			cancelled: false
		});
		s.shellWait = { command: 'sleep 9' };
		expect(await dispatch(op({ type: 'session.cancelShellWait', id: 'a' }), 'w')).toEqual({
			cancelled: true
		});
	});

	it('resyncs a watched session and refuses one nobody watches', async () => {
		mocks.open = [session('a') as unknown as Record<string, unknown>];
		await expect(dispatch(op({ type: 'session.resync', id: 'a' }), 'w')).rejects.toThrow(
			'session a is not being watched'
		);
		setResync((id) => id === 'a');
		expect(await dispatch(op({ type: 'session.resync', id: 'a' }), 'w')).toEqual({
			resynced: 'a'
		});
	});
});

describe('dispatch: session.readFile', () => {
	function withFile(content: string, over: Partial<FakeSession> = {}) {
		mocks.open = [session('a', over) as unknown as Record<string, unknown>];
		mocks.invoke.mockImplementation(invokeRouter({ fs_read_text_full: content }));
	}

	it('reads a file by relative or absolute path inside the folder', async () => {
		withFile('hello');
		expect(
			await dispatch(op({ type: 'session.readFile', id: 'a', path: 'src/x.ts' }), 'w')
		).toEqual({ path: 'src/x.ts', content: 'hello', truncated: false });
		await dispatch(op({ type: 'session.readFile', id: 'a', path: '/proj/a/src/y.ts' }), 'w');
		expect(invokeCalls(mocks.invoke, 'fs_read_text_full')).toEqual([
			{ workdir: '/proj/a', relPath: 'src/x.ts' },
			{ workdir: '/proj/a', relPath: 'src/y.ts' }
		]);
	});

	it("reads a WSL session's file through its distro's share", async () => {
		withFile('x', { root: '/home/me/p', wslDistro: 'Ubuntu' });
		await dispatch(op({ type: 'session.readFile', id: 'a', path: 'a.txt' }), 'w');
		expect(invokeCalls(mocks.invoke, 'fs_read_text_full')).toEqual([
			{ workdir: '\\\\wsl.localhost\\Ubuntu\\home\\me\\p', relPath: 'a.txt' }
		]);
	});

	it('refuses a path outside the folder without reading anything', async () => {
		withFile('secret');
		for (const path of ['../b/x', '/etc/passwd', '~/.ssh/id_rsa', '/proj/a']) {
			await expect(dispatch(op({ type: 'session.readFile', id: 'a', path }), 'w')).rejects.toThrow(
				"outside the session's folder"
			);
		}
		expect(invokeCalls(mocks.invoke, 'fs_read_text_full')).toEqual([]);
	});

	it('sends a file of exactly MAX_FILE_CHARS whole', async () => {
		withFile('a'.repeat(MAX_FILE_CHARS));
		const out = (await dispatch(op({ type: 'session.readFile', id: 'a', path: 'f' }), 'w')) as {
			content: string;
			truncated: boolean;
		};
		expect(out.truncated).toBe(false);
		expect(out.content.length).toBe(MAX_FILE_CHARS);
	});

	it('cuts a longer file to MAX_FILE_CHARS and says so', async () => {
		withFile('a'.repeat(MAX_FILE_CHARS) + 'TAIL');
		const out = (await dispatch(op({ type: 'session.readFile', id: 'a', path: 'f' }), 'w')) as {
			content: string;
			truncated: boolean;
		};
		expect(out.truncated).toBe(true);
		expect(out.content.length).toBe(MAX_FILE_CHARS);
		expect(out.content.endsWith('TAIL')).toBe(false);
	});

	it('passes a read error through', async () => {
		mocks.open = [session('a') as unknown as Record<string, unknown>];
		mocks.invoke.mockImplementation(
			invokeRouter({
				fs_read_text_full: () => {
					throw new Error('not a text file');
				}
			})
		);
		await expect(
			dispatch(op({ type: 'session.readFile', id: 'a', path: 'img.png' }), 'w')
		).rejects.toThrow('not a text file');
	});
});

describe('dispatch: chats and prompts', () => {
	it('runs chat operations in the main window only', async () => {
		mocks.dispatchChat.mockResolvedValue({ chats: [] });
		expect(await dispatch(op({ type: 'chats.list' }), MAIN_WINDOW)).toEqual({ chats: [] });
		await expect(dispatch(op({ type: 'chat.new' }), 'code-1')).rejects.toThrow(
			'chat runs in the main window'
		);
	});

	it('resyncs the open chat, and refuses another', async () => {
		setChatResync((id) => id === 'c1');
		expect(await dispatch(op({ type: 'chat.resync', id: 'c1' }), MAIN_WINDOW)).toEqual({
			resynced: 'c1'
		});
		await expect(dispatch(op({ type: 'chat.resync', id: 'c2' }), MAIN_WINDOW)).rejects.toThrow(
			"chat c2 isn't the open chat"
		);
	});

	it("lists and answers this window's prompts", async () => {
		mocks.currentPrompts.mockImplementation((label: string) => [{ id: `p-${label}` }]);
		expect(await dispatch(op({ type: 'prompts.list' }), 'w9')).toEqual([{ id: 'p-w9' }]);
		const answer = { kind: 'approve' } as unknown as Extract<
			EngineOp,
			{ type: 'prompts.answer' }
		>['answer'];
		expect(await dispatch(op({ type: 'prompts.answer', promptId: 'p1', answer }), 'w9')).toEqual({
			answered: 'p1'
		});
		expect(mocks.answerPrompt.mock.calls).toEqual([['w9', 'p1', answer]]);
	});

	it('refuses an operation it does not know', async () => {
		await expect(
			dispatch({ type: 'session.explode' } as unknown as EngineOp, MAIN_WINDOW)
		).rejects.toThrow('unknown operation session.explode');
	});
});
