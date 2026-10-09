import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
	handOffSession: vi.fn(async (id: string) => {
		void id;
		return true;
	}),
	openSession: vi.fn(async (id: string): Promise<unknown> => ({ id, prefill: null })),
	forkAndOpen: vi.fn(async () => ({})),
	forkSession: vi.fn(async () => ({ id: 'fork-1', prefill: { text: 'edit me', images: [] } })),
	newSession: vi.fn(async () => ({}))
}));
vi.mock('#lib/stores/code.svelte.ts', () => store);
const createCodeSession = vi.hoisted(() => vi.fn(async () => ({ id: 'new-1' })));
vi.mock('#lib/code/db.ts', () => ({ createCodeSession }));
vi.mock('@tauri-apps/api/event', () => ({ emitTo: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn() }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({ WebviewWindow: vi.fn() }));

import type { CodeSession, CodeSessionStatus } from '#lib/stores/code.svelte.ts';
import {
	REATTACH_EVENT,
	codeWindowLabel,
	codeWindowUrl,
	detachSession,
	forkFromMessage,
	markDetachedCodeWindow,
	moveBlockedReason,
	newSessionBeside,
	reattachHandler,
	reattachToMain,
	type CodeWindowApi
} from './windows';
import {
	hasShellCommandOpener,
	openShellForCommand,
	registerShellCommandOpener,
	useShellRelay
} from './shellBridge';

function session(status: CodeSessionStatus = 'idle'): CodeSession {
	return { id: 's1', title: 'Refactor', root: '/p/app', status } as CodeSession;
}

function api(): CodeWindowApi & { [K in keyof CodeWindowApi]: ReturnType<typeof vi.fn> } {
	return {
		create: vi.fn(async () => {}),
		emitToMain: vi.fn(async () => {}),
		raiseMain: vi.fn(async () => {}),
		closeSelf: vi.fn(async () => {})
	};
}

beforeEach(() => {
	for (const f of Object.values(store)) f.mockClear();
});

describe('code windows', () => {
	it('labels a window by its session and routes it to /code/<id>', () => {
		expect(codeWindowLabel('ab-12')).toBe('code-ab-12');
		expect(codeWindowUrl('ab-12')).toBe('/code/ab-12');
	});

	it('says why a session that is not idle cannot move', () => {
		expect(moveBlockedReason(session())).toBeNull();
		expect(moveBlockedReason(session('running'))).toMatch(/turn is running/);
		expect(moveBlockedReason(session('queued'))).toMatch(/another turn/);
		expect(moveBlockedReason(session('waiting-shell'))).toMatch(/Shell tab/);
	});

	it('does not detach while a turn runs', async () => {
		const a = api();
		for (const status of ['running', 'queued', 'waiting-shell'] as const) {
			expect(await detachSession(session(status), a)).toBe(false);
		}
		expect(store.handOffSession).not.toHaveBeenCalled();
		expect(a.create).not.toHaveBeenCalled();
	});

	it('detaches by handing the session off, then opening its window', async () => {
		const a = api();
		expect(await detachSession(session(), a)).toBe(true);
		expect(store.handOffSession).toHaveBeenCalledWith('s1');
		expect(a.create).toHaveBeenCalledWith('s1', 'Refactor — Haruspex Code');
		expect(store.handOffSession.mock.invocationCallOrder[0]).toBeLessThan(
			a.create.mock.invocationCallOrder[0]
		);
	});

	it('takes the session back when its window cannot be made', async () => {
		const a = api();
		a.create.mockRejectedValueOnce(new Error('label in use'));
		await expect(detachSession(session(), a)).rejects.toThrow('label in use');
		expect(store.openSession).toHaveBeenCalledWith('s1');
	});

	it('re-attaches: hands off, asks main to open it, closes this window', async () => {
		const a = api();
		expect(await reattachToMain(session(), a)).toBe(true);
		expect(store.handOffSession).toHaveBeenCalledWith('s1');
		expect(a.emitToMain).toHaveBeenCalledWith(REATTACH_EVENT, { id: 's1' });
		expect(a.closeSelf).toHaveBeenCalled();
		expect(await reattachToMain(session('running'), a)).toBe(false);
		expect(a.emitToMain).toHaveBeenCalledTimes(1);
	});

	it('main opens a re-attached session as a sub-tab and comes to the front', async () => {
		const onOpen = vi.fn();
		const raise = vi.fn(async () => {});
		await reattachHandler(onOpen, raise)({ id: 's1' });
		expect(onOpen).toHaveBeenCalled();
		expect(store.openSession).toHaveBeenCalledWith('s1');
		expect(raise).toHaveBeenCalled();
	});

	it('main gives a fork made elsewhere its input text', async () => {
		const opened = { id: 'fork-1', prefill: null as unknown };
		store.openSession.mockResolvedValueOnce(opened);
		const prefill = { text: 'edit me', images: [] };
		await reattachHandler(vi.fn(), async () => {})({ id: 'fork-1', prefill });
		expect(opened.prefill).toEqual(prefill);
	});

	it('forks into a sub-tab here in the main window', async () => {
		const a = api();
		await forkFromMessage(session(), 3, a);
		expect(store.forkAndOpen).toHaveBeenCalledWith('s1', 3);
		expect(a.emitToMain).not.toHaveBeenCalled();
	});

	it('starts /new beside the session, as a sub-tab here', async () => {
		const a = api();
		await newSessionBeside(session(), a);
		expect(store.newSession).toHaveBeenCalledWith('/p/app');
		expect(a.emitToMain).not.toHaveBeenCalled();
	});

	it('sends a fork made in a detached window to the main window', async () => {
		const a = api();
		markDetachedCodeWindow();
		await forkFromMessage(session(), 2, a);
		expect(store.forkAndOpen).not.toHaveBeenCalled();
		expect(store.forkSession).toHaveBeenCalledWith('s1', 2);
		expect(a.emitToMain).toHaveBeenCalledWith(REATTACH_EVENT, {
			id: 'fork-1',
			prefill: { text: 'edit me', images: [] }
		});
		expect(a.raiseMain).toHaveBeenCalled();
	});

	it('starts /new from a detached window in the main window', async () => {
		const a = api();
		await newSessionBeside(session(), a);
		expect(store.newSession).not.toHaveBeenCalled();
		expect(createCodeSession).toHaveBeenCalledWith('/p/app');
		expect(a.emitToMain).toHaveBeenCalledWith(REATTACH_EVENT, { id: 'new-1' });
	});
});

describe('the shell bridge in a detached window', () => {
	it('prefers the relay over the local shell store’s opener', async () => {
		const local = vi.fn(async () => ({ kind: 'unavailable' as const, message: 'local' }));
		const offLocal = registerShellCommandOpener(local);
		const relay = vi.fn(async () => ({
			kind: 'opened' as const,
			shellName: 'Shell 1',
			integration: true
		}));
		const offRelay = useShellRelay(relay);
		expect(hasShellCommandOpener()).toBe(true);
		expect(await openShellForCommand({ command: 'x', cwd: '/p', wait: false })).toMatchObject({
			kind: 'opened'
		});
		expect(local).not.toHaveBeenCalled();
		offRelay();
		expect(await openShellForCommand({ command: 'x', cwd: '/p', wait: false })).toMatchObject({
			message: 'local'
		});
		offLocal();
		expect(hasShellCommandOpener()).toBe(false);
	});
});
