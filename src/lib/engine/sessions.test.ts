import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	open: [] as Array<Record<string, unknown>>,
	closeSession: vi.fn(),
	deleteSession: vi.fn(),
	forkSession: vi.fn(),
	updateMeta: vi.fn()
}));

vi.mock('#lib/stores/code.svelte.ts', () => ({
	getOpenSessions: () => mocks.open,
	closeSession: mocks.closeSession,
	deleteSession: mocks.deleteSession,
	forkSession: mocks.forkSession
}));
vi.mock('#lib/code/db.ts', () => ({ updateCodeSessionMeta: mocks.updateMeta }));

import { dispatchSession } from './sessions.ts';

function session(id: string) {
	const s = {
		id,
		backend: null as unknown,
		effort: null as string | null,
		title: 'old',
		background: [{ id: 'bg1' }],
		stopped: [] as string[],
		rename: vi.fn(async (t: string) => void (s.title = t)),
		setEffort: vi.fn(async (e: string | null) => void (s.effort = e)),
		setBackend: vi.fn(async (b: unknown) => void (s.backend = b)),
		stopBackground: vi.fn(async (p: string) => void s.stopped.push(p))
	};
	return s;
}

beforeEach(() => {
	mocks.open = [];
	for (const m of [mocks.closeSession, mocks.deleteSession, mocks.forkSession, mocks.updateMeta]) {
		m.mockReset();
	}
});

describe('session controls', () => {
	it('closes an open session, and says when it was not open', async () => {
		mocks.open = [session('a')];
		expect(await dispatchSession({ type: 'session.close', id: 'a' })).toEqual({ closed: true });
		expect(mocks.closeSession).toHaveBeenCalledWith('a');
		expect(await dispatchSession({ type: 'session.close', id: 'b' })).toEqual({ closed: false });
	});

	it('deletes a session, refusing one another window has', async () => {
		mocks.deleteSession.mockResolvedValueOnce({ worktree: null }).mockResolvedValueOnce(false);
		expect(await dispatchSession({ type: 'session.delete', id: 'a' })).toEqual({ deleted: 'a' });
		await expect(dispatchSession({ type: 'session.delete', id: 'b' })).rejects.toThrow(
			'open in its own window'
		);
	});

	it('forks from a message without opening the fork', async () => {
		mocks.forkSession.mockResolvedValue({ id: 'f', prefill: { text: 'try again', images: [] } });
		expect(
			await dispatchSession({ type: 'session.fork', id: 'a', index: 2, mode: 'worktree' })
		).toEqual({ id: 'f', prefill: 'try again' });
		expect(mocks.forkSession).toHaveBeenCalledWith('a', 2, 'worktree');
	});

	it('renames an open session, or a saved one no window has', async () => {
		const s = session('a');
		mocks.open = [s];
		await dispatchSession({ type: 'session.rename', id: 'a', title: '  New  ' });
		expect(s.title).toBe('New');
		await dispatchSession({ type: 'session.rename', id: 'b', title: 'Saved' });
		expect(mocks.updateMeta).toHaveBeenCalledWith('b', { title: 'Saved' });
		await expect(dispatchSession({ type: 'session.rename', id: 'a', title: ' ' })).rejects.toThrow(
			'needs a title'
		);
	});

	it('sets the effort, or back to Settings, and refuses a level that is not one', async () => {
		const s = session('a');
		mocks.open = [s];
		await dispatchSession({ type: 'session.effort', id: 'a', effort: 'high' });
		expect(s.effort).toBe('high');
		await dispatchSession({ type: 'session.effort', id: 'a', effort: null });
		expect(s.effort).toBeNull();
		await expect(
			dispatchSession({ type: 'session.effort', id: 'a', effort: 'max' })
		).rejects.toThrow('effort is one of');
	});

	it('sets the model with a key by id, and refuses an inline key', async () => {
		const s = session('a');
		mocks.open = [s];
		await dispatchSession({
			type: 'session.model',
			id: 'a',
			model: { baseUrl: 'http://box:3000/', modelId: ' qwen ', apiKeyId: 'k1' }
		});
		expect(s.backend).toEqual({ baseUrl: 'http://box:3000', modelId: 'qwen', apiKeyId: 'k1' });
		await expect(
			dispatchSession({
				type: 'session.model',
				id: 'a',
				model: { baseUrl: 'http://box', apiKey: 'sk' } as never
			})
		).rejects.toThrow('send apiKeyId');
		await expect(
			dispatchSession({ type: 'session.model', id: 'a', model: { baseUrl: 'box:3000' } })
		).rejects.toThrow('server address');
		await dispatchSession({ type: 'session.model', id: 'a', model: null });
		expect(s.backend).toBeNull();
	});

	it("stops one of the session's own background processes, and no other", async () => {
		const s = session('a');
		mocks.open = [s];
		await dispatchSession({ type: 'session.stopBackground', id: 'a', processId: 'bg1' });
		expect(s.stopped).toEqual(['bg1']);
		await expect(
			dispatchSession({ type: 'session.stopBackground', id: 'a', processId: 'other' })
		).rejects.toThrow('no background process other');
	});

	it('wants a session open for what only an open one has', async () => {
		await expect(
			dispatchSession({ type: 'session.effort', id: 'z', effort: null })
		).rejects.toThrow('open it first');
	});
});
