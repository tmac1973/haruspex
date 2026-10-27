import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
	updates: [] as Record<string, unknown>[],
	generate: vi.fn(),
	resume: vi.fn()
}));
vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn(async (cmd: string, args: { id: string; patch: Record<string, unknown> }) => {
		if (cmd !== 'task_update') return null;
		state.updates.push(args.patch);
		return { id: args.id, ...args.patch };
	})
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
	getCurrentWebviewWindow: () => ({ label: 'main' })
}));
vi.mock('#lib/music/index.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/music/index.ts')>()),
	resolveMusicBackend: () => ({ kind: 'llama-toolchest', generate: state.generate })
}));
vi.mock('#lib/music/registry.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/music/registry.ts')>()),
	getMusicBackend: () => ({ kind: 'llama-toolchest', resume: state.resume })
}));

import './followers.ts';
import { _dispatchForTests as dispatch } from './runner.svelte.ts';
import { MusicBackendError, type MusicGenerateOptions } from '#lib/music/types.ts';
import type { MusicTaskSpec } from '#lib/agent/tools/_musicJob.ts';
import type { BackgroundTask } from './types.ts';

const HASH = 'e'.repeat(64);
const made = {
	hash: HASH,
	url: `haruspex-audio://localhost/${HASH}`,
	mime: 'audio/mpeg',
	durationSec: 45,
	seed: 7,
	model: 'ace-gpu2'
};
const spec: MusicTaskSpec = {
	request: {
		title: 'Rain',
		caption: 'lo-fi',
		instrumental: true,
		durationSec: 45,
		seed: 7,
		format: 'mp3'
	},
	notes: [],
	save: null,
	conversationId: null,
	codeSessionId: 'code-1'
};
const handle = { backend: 'llama-toolchest', baseUrl: 'http://box:3000', id: 'j1', model: 'x' };

function task(over: Partial<BackgroundTask> = {}): BackgroundTask {
	return {
		id: 'm1',
		kind: 'music',
		owner: 'code:code-1',
		label: 'Making Rain',
		state: 'pending',
		follower: 'frontend',
		percent: null,
		etaSecs: null,
		phase: null,
		queuePosition: null,
		spec,
		handle: null,
		result: null,
		error: null,
		logTail: null,
		startedMs: 1,
		endedMs: null,
		noticeDelivered: false,
		...over
	};
}

beforeEach(() => {
	state.updates = [];
	state.generate.mockReset();
	state.resume.mockReset();
});

describe('the music follower', () => {
	it('makes the song for its owner, records the job, and ends done', async () => {
		state.generate.mockImplementation(async (_req, opts: MusicGenerateOptions) => {
			opts.onProgress?.({ phase: 'queued', ahead: 2 });
			opts.onHandle?.(handle as never);
			return made;
		});
		await dispatch(task(), 'run');
		expect(state.generate).toHaveBeenCalledWith(
			spec.request,
			expect.objectContaining({ codeSessionId: 'code-1', conversationId: undefined })
		);
		expect(state.updates).toEqual([
			{ state: 'running' },
			{ phase: 'queued', queuePosition: 3 },
			{ handle },
			{ state: 'done', result: expect.objectContaining({ hash: HASH, title: 'Rain' }) }
		]);
	});

	it('follows a job an earlier run sent, from its handle', async () => {
		state.resume.mockResolvedValue(made);
		await dispatch(task({ state: 'running', handle }), 'resume');
		expect(state.resume).toHaveBeenCalledWith(handle, spec.request, expect.anything());
		expect(state.updates.at(-1)).toMatchObject({ state: 'done' });
	});

	it('says when the server no longer has the job', async () => {
		state.resume.mockRejectedValue(new MusicBackendError('rejected', 'nope', { status: 404 }));
		await dispatch(task({ state: 'running', handle }), 'resume');
		expect(state.updates.at(-1)).toEqual({
			state: 'failed',
			error: 'The server no longer has this job.'
		});
	});

	it('ends cancelled when the backend says so', async () => {
		state.generate.mockRejectedValue(new MusicBackendError('cancelled', 'Cancelled.'));
		await dispatch(task(), 'run');
		expect(state.updates.at(-1)).toEqual({ state: 'cancelled' });
	});
});
