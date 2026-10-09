import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

import {
	listCodeSessions,
	createCodeSession,
	loadCodeSession,
	saveCodeSession,
	updateCodeSessionMeta,
	deleteCodeSession,
	forkCodeSession,
	decodeAgentBranch,
	folderExists,
	setCodeSessionRoot
} from '#lib/code/db.ts';

const backend = { baseUrl: 'https://api.example.com', modelId: 'm' };

function row(over: Record<string, unknown> = {}) {
	return {
		id: 's1',
		title: '',
		root: '/work',
		backend: null,
		reasoning_effort: null,
		thread: '{}',
		forked_from: null,
		forked_at: null,
		created_at: 1,
		updated_at: 1,
		...over
	};
}

beforeEach(() => {
	mocks.invoke.mockReset();
});

describe('code session wrappers', () => {
	it('lists with no arguments', async () => {
		mocks.invoke.mockResolvedValueOnce([]);
		await listCodeSessions();
		expect(mocks.invoke).toHaveBeenCalledWith('code_session_list');
	});

	it('creates with the backend as JSON and decodes it back', async () => {
		mocks.invoke.mockResolvedValueOnce(row({ backend: JSON.stringify(backend) }));
		const rec = await createCodeSession('/work', { backend, effort: 'low' });
		expect(mocks.invoke).toHaveBeenCalledWith('code_session_create', {
			root: '/work',
			backend: JSON.stringify(backend),
			effort: 'low'
		});
		expect(rec.backend).toEqual(backend);
	});

	it('creates on the global backend and effort by default', async () => {
		mocks.invoke.mockResolvedValueOnce(row());
		const rec = await createCodeSession('/work');
		expect(mocks.invoke).toHaveBeenCalledWith('code_session_create', {
			root: '/work',
			backend: null,
			effort: null
		});
		expect(rec.backend).toBeNull();
	});

	it('loads by id, treating an unparseable backend as the global one', async () => {
		mocks.invoke.mockResolvedValueOnce(row({ backend: 'not json' }));
		const rec = await loadCodeSession('s1');
		expect(mocks.invoke).toHaveBeenCalledWith('code_session_load', { id: 's1' });
		expect(rec.backend).toBeNull();
	});

	it('saves the thread with an optional title', async () => {
		mocks.invoke.mockResolvedValue(undefined);
		await saveCodeSession('s1', '{"v":1}');
		expect(mocks.invoke).toHaveBeenLastCalledWith('code_session_save', {
			id: 's1',
			thread: '{"v":1}',
			title: null,
			noticesSeenAt: null,
			agentBranch: null
		});
		await saveCodeSession('s1', '{"v":1}', 'Named');
		expect(mocks.invoke).toHaveBeenLastCalledWith(
			'code_session_save',
			expect.objectContaining({ title: 'Named' })
		);
	});

	it('saves what the agent was told, keeping "never told" apart from "no branch"', async () => {
		mocks.invoke.mockResolvedValue(undefined);
		const sent = async (agentBranch: string | null | undefined) => {
			await saveCodeSession('s1', '{}', undefined, { noticesSeenAt: 42, agentBranch });
			return mocks.invoke.mock.calls.at(-1)![1];
		};
		expect(await sent('main')).toMatchObject({ noticesSeenAt: 42, agentBranch: 'main' });
		expect(await sent(null)).toMatchObject({ agentBranch: '' });
		expect(await sent(undefined)).toMatchObject({ agentBranch: null });
		expect(decodeAgentBranch('main')).toBe('main');
		expect(decodeAgentBranch('')).toBeNull();
		expect(decodeAgentBranch(null)).toBeUndefined();
	});

	it('points a session at another folder, and checks a folder is there', async () => {
		mocks.invoke.mockResolvedValueOnce(row({ root: '/new' }));
		const moved = await setCodeSessionRoot('s1', '/new');
		expect(mocks.invoke).toHaveBeenLastCalledWith('code_session_set_root', {
			id: 's1',
			root: '/new'
		});
		expect(moved.root).toBe('/new');
		mocks.invoke.mockResolvedValueOnce(false);
		expect(await folderExists('/gone')).toBe(false);
		expect(mocks.invoke).toHaveBeenLastCalledWith('code_folder_exists', { path: '/gone' });
		mocks.invoke.mockResolvedValueOnce(true);
		expect(await folderExists('/here')).toBe(true);
		// A failed check is no reason to lock the session.
		mocks.invoke.mockRejectedValueOnce(new Error('ipc'));
		expect(await folderExists('/x')).toBe(true);
	});

	it('sends only the meta fields given, keeping null distinct from absent', async () => {
		mocks.invoke.mockResolvedValue(undefined);
		await updateCodeSessionMeta('s1', { title: 'T' });
		expect(mocks.invoke).toHaveBeenLastCalledWith('code_session_update_meta', {
			id: 's1',
			patch: { title: 'T' }
		});
		await updateCodeSessionMeta('s1', { backend: null, effort: null });
		expect(mocks.invoke).toHaveBeenLastCalledWith('code_session_update_meta', {
			id: 's1',
			patch: { backend: null, effort: null }
		});
		await updateCodeSessionMeta('s1', { backend });
		expect(mocks.invoke).toHaveBeenLastCalledWith('code_session_update_meta', {
			id: 's1',
			patch: { backend: JSON.stringify(backend) }
		});
	});

	it('deletes and forks by id', async () => {
		mocks.invoke.mockResolvedValueOnce(undefined);
		await deleteCodeSession('s1');
		expect(mocks.invoke).toHaveBeenLastCalledWith('code_session_delete', { id: 's1' });

		mocks.invoke.mockResolvedValueOnce(row({ id: 's2', forked_from: 's1', forked_at: 3 }));
		const fork = await forkCodeSession('s1', 3, 'worktree');
		expect(mocks.invoke).toHaveBeenLastCalledWith('code_session_fork', {
			id: 's1',
			at: 3,
			mode: 'worktree'
		});
		expect(fork.forked_from).toBe('s1');
	});

	it('propagates a failure instead of swallowing it', async () => {
		mocks.invoke.mockRejectedValueOnce('Code session s9 not found');
		await expect(loadCodeSession('s9')).rejects.toBe('Code session s9 not found');
	});
});
