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
	forkCodeSession
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
			title: null
		});
		await saveCodeSession('s1', '{"v":1}', 'Named');
		expect(mocks.invoke).toHaveBeenLastCalledWith('code_session_save', {
			id: 's1',
			thread: '{"v":1}',
			title: 'Named'
		});
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
		const fork = await forkCodeSession('s1', 3);
		expect(mocks.invoke).toHaveBeenLastCalledWith('code_session_fork', { id: 's1', at: 3 });
		expect(fork.forked_from).toBe('s1');
	});

	it('propagates a failure instead of swallowing it', async () => {
		mocks.invoke.mockRejectedValueOnce('Code session s9 not found');
		await expect(loadCodeSession('s9')).rejects.toBe('Code session s9 not found');
	});
});
