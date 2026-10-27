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
vi.mock('#lib/videogen/toolchest.ts', () => ({
	generateVideo: state.generate,
	resumeVideo: state.resume
}));

import './followers.ts';
import { _dispatchForTests as dispatch } from './runner.svelte.ts';
import { ToolchestError } from '#lib/toolchest/client.ts';
import type { VideoTaskSpec } from '#lib/agent/tools/_videoJob.ts';
import type { VideoGenerateOptions } from '#lib/videogen/types.ts';
import type { BackgroundTask } from './types.ts';

const HASH = 'e'.repeat(64);
const made = {
	hash: HASH,
	url: `haruspex-video://localhost/${HASH}`,
	mime: 'video/webm',
	width: 832,
	height: 480,
	frames: 33,
	fps: 24,
	seed: 7,
	model: 'ti2v'
};
const spec: VideoTaskSpec = {
	request: {
		title: 'Fox',
		prompt: 'a fox',
		width: 832,
		height: 480,
		frames: 33,
		fps: 24,
		seed: 7
	},
	notes: [],
	save: null,
	conversationId: 'c1',
	codeSessionId: null
};
const handle = {
	backend: 'llama-toolchest',
	baseUrl: 'http://box:3000',
	id: 'j1',
	model: 'ti2v',
	keyId: ''
};

function task(over: Partial<BackgroundTask> = {}): BackgroundTask {
	return {
		id: 'v1',
		kind: 'video',
		owner: 'chat:c1',
		label: 'Making Fox',
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

describe('the video follower', () => {
	it('makes the clip for its chat, records the job and its steps, and ends done', async () => {
		state.generate.mockImplementation(async (_req, opts: VideoGenerateOptions) => {
			opts.onHandle?.(handle as never);
			opts.onProgress?.({ phase: 'generating', step: 5, totalSteps: 20 });
			return made;
		});
		await dispatch(task(), 'run');
		expect(state.generate).toHaveBeenCalledWith(
			spec.request,
			expect.objectContaining({ conversationId: 'c1', codeSessionId: undefined })
		);
		expect(state.updates).toEqual([
			{ state: 'running' },
			{ handle },
			{ phase: 'generating', percent: 25, queuePosition: null },
			{ state: 'done', result: expect.objectContaining({ hash: HASH, title: 'Fox', frames: 33 }) }
		]);
	});

	it('follows a job an earlier run sent, from its handle', async () => {
		state.resume.mockResolvedValue(made);
		await dispatch(task({ state: 'running', handle }), 'resume');
		expect(state.resume).toHaveBeenCalledWith(handle, spec.request, expect.anything());
		expect(state.updates.at(-1)).toMatchObject({ state: 'done' });
	});

	it('says when the server no longer has the job', async () => {
		state.resume.mockRejectedValue(new ToolchestError('rejected', 'gone', { status: 404 }));
		await dispatch(task({ state: 'running', handle }), 'resume');
		expect(state.updates.at(-1)).toEqual({
			state: 'failed',
			error: 'The server no longer has this job.'
		});
	});

	it('ends cancelled when the job was cancelled', async () => {
		state.generate.mockRejectedValue(new ToolchestError('cancelled', 'Cancelled.'));
		await dispatch(task(), 'run');
		expect(state.updates.at(-1)).toEqual({ state: 'cancelled' });
	});
});
