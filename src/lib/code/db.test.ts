import { invoke } from '@tauri-apps/api/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

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
	vi.mocked(invoke).mockReset();
});

describe('code session wrappers', () => {
	it('lists with no arguments', async () => {
		vi.mocked(invoke).mockResolvedValueOnce([]);
		await listCodeSessions();
		expect(invoke).toHaveBeenCalledWith('code_session_list');
	});

	it('creates with the backend as JSON and decodes it back', async () => {
		vi.mocked(invoke).mockResolvedValueOnce(row({ backend: JSON.stringify(backend) }));
		const rec = await createCodeSession('/work', { backend, effort: 'low' });
		expect(invoke).toHaveBeenCalledWith('code_session_create', {
			root: '/work',
			wslDistro: null,
			backend: JSON.stringify(backend),
			effort: 'low',
			worktree: false
		});
		expect(rec.backend).toEqual(backend);
	});

	it('creates on the global backend and effort by default', async () => {
		vi.mocked(invoke).mockResolvedValueOnce(row());
		const rec = await createCodeSession('/work');
		expect(invoke).toHaveBeenCalledWith('code_session_create', {
			root: '/work',
			wslDistro: null,
			backend: null,
			effort: null,
			worktree: false
		});
		expect(rec.backend).toBeNull();
	});

	it('decodes the specialist list, and treats a broken one as the defaults', async () => {
		vi.mocked(invoke).mockResolvedValueOnce(row({ specialists: '["a","b"]' }));
		expect((await loadCodeSession('s1')).specialists).toEqual(['a', 'b']);
		vi.mocked(invoke).mockResolvedValueOnce(row({ specialists: null }));
		expect((await loadCodeSession('s1')).specialists).toBeNull();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		for (const bad of ['not json', '{"a":1}', '[1,2]']) {
			vi.mocked(invoke).mockResolvedValueOnce(row({ specialists: bad }));
			expect((await loadCodeSession('s1')).specialists).toBeNull();
		}
		expect(warn).toHaveBeenCalledTimes(3);
		warn.mockRestore();
	});

	it('decodes the helper list apart from the specialists', async () => {
		vi.mocked(invoke).mockResolvedValueOnce(row({ helpers: '["three"]', specialists: null }));
		const rec = await loadCodeSession('s1');
		expect(rec.helpers).toEqual(['three']);
		expect(rec.specialists).toBeNull();
		vi.mocked(invoke).mockResolvedValueOnce(row());
		expect((await loadCodeSession('s1')).helpers).toBeNull();
	});

	it('loads by id, treating an unparseable backend as the global one', async () => {
		vi.mocked(invoke).mockResolvedValueOnce(row({ backend: 'not json' }));
		const rec = await loadCodeSession('s1');
		expect(invoke).toHaveBeenCalledWith('code_session_load', { id: 's1' });
		expect(rec.backend).toBeNull();
	});

	it('saves the thread with an optional title', async () => {
		vi.mocked(invoke).mockResolvedValue(undefined);
		await saveCodeSession('s1', '{"v":1}');
		expect(invoke).toHaveBeenLastCalledWith('code_session_save', {
			id: 's1',
			thread: '{"v":1}',
			title: null,
			noticesSeenAt: null,
			agentBranch: null
		});
		await saveCodeSession('s1', '{"v":1}', 'Named');
		expect(invoke).toHaveBeenLastCalledWith(
			'code_session_save',
			expect.objectContaining({ title: 'Named' })
		);
	});

	it('saves what the agent was told, keeping "never told" apart from "no branch"', async () => {
		vi.mocked(invoke).mockResolvedValue(undefined);
		const sent = async (agentBranch: string | null | undefined) => {
			await saveCodeSession('s1', '{}', undefined, { noticesSeenAt: 42, agentBranch });
			return vi.mocked(invoke).mock.calls.at(-1)![1];
		};
		expect(await sent('main')).toMatchObject({ noticesSeenAt: 42, agentBranch: 'main' });
		expect(await sent(null)).toMatchObject({ agentBranch: '' });
		expect(await sent(undefined)).toMatchObject({ agentBranch: null });
		expect(decodeAgentBranch('main')).toBe('main');
		expect(decodeAgentBranch('')).toBeNull();
		expect(decodeAgentBranch(null)).toBeUndefined();
	});

	it('points a session at another folder, and checks a folder is there', async () => {
		vi.mocked(invoke).mockResolvedValueOnce(row({ root: '/new' }));
		const moved = await setCodeSessionRoot('s1', '/new');
		expect(invoke).toHaveBeenLastCalledWith('code_session_set_root', {
			id: 's1',
			root: '/new',
			wslDistro: null
		});
		expect(moved.root).toBe('/new');
		vi.mocked(invoke).mockResolvedValueOnce(false);
		expect(await folderExists('/gone')).toBe(false);
		expect(invoke).toHaveBeenLastCalledWith('code_folder_exists', {
			path: '/gone',
			wslDistro: null
		});
		vi.mocked(invoke).mockResolvedValueOnce(true);
		expect(await folderExists('/here')).toBe(true);
		// A failed check is no reason to lock the session.
		vi.mocked(invoke).mockRejectedValueOnce(new Error('ipc'));
		expect(await folderExists('/x')).toBe(true);
	});

	it('sends only the meta fields given, keeping null distinct from absent', async () => {
		vi.mocked(invoke).mockResolvedValue(undefined);
		await updateCodeSessionMeta('s1', { title: 'T' });
		expect(invoke).toHaveBeenLastCalledWith('code_session_update_meta', {
			id: 's1',
			patch: { title: 'T' }
		});
		await updateCodeSessionMeta('s1', { backend: null, effort: null });
		expect(invoke).toHaveBeenLastCalledWith('code_session_update_meta', {
			id: 's1',
			patch: { backend: null, effort: null }
		});
		await updateCodeSessionMeta('s1', { backend });
		expect(invoke).toHaveBeenLastCalledWith('code_session_update_meta', {
			id: 's1',
			patch: { backend: JSON.stringify(backend) }
		});
		await updateCodeSessionMeta('s1', { specialists: ['a', 'b'] });
		expect(invoke).toHaveBeenLastCalledWith('code_session_update_meta', {
			id: 's1',
			patch: { specialists: '["a","b"]' }
		});
		await updateCodeSessionMeta('s1', { specialists: null });
		expect(invoke).toHaveBeenLastCalledWith('code_session_update_meta', {
			id: 's1',
			patch: { specialists: null }
		});
		await updateCodeSessionMeta('s1', { helpers: ['three'] });
		expect(invoke).toHaveBeenLastCalledWith('code_session_update_meta', {
			id: 's1',
			patch: { helpers: '["three"]' }
		});
	});

	it('deletes and forks by id', async () => {
		vi.mocked(invoke).mockResolvedValueOnce(undefined);
		await deleteCodeSession('s1');
		expect(invoke).toHaveBeenLastCalledWith('code_session_delete', { id: 's1' });

		vi.mocked(invoke).mockResolvedValueOnce(row({ id: 's2', forked_from: 's1', forked_at: 3 }));
		const fork = await forkCodeSession('s1', 3, 'worktree');
		expect(invoke).toHaveBeenLastCalledWith('code_session_fork', {
			id: 's1',
			at: 3,
			mode: 'worktree'
		});
		expect(fork.forked_from).toBe('s1');
	});

	it('propagates a failure instead of swallowing it', async () => {
		vi.mocked(invoke).mockRejectedValueOnce('Code session s9 not found');
		await expect(loadCodeSession('s9')).rejects.toBe('Code session s9 not found');
	});
});
