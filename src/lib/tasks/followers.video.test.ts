import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
	updates: [] as Record<string, unknown>[],
	generate: vi.fn(),
	resume: vi.fn(),
	upscale: vi.fn(),
	resumeUpscale: vi.fn(),
	muxed: [] as Record<string, unknown>[],
	builtFor: [] as { id: string; url: string; model: string }[]
}));
vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore(
		{},
		async (cmd: string, args: { id: string; patch: Record<string, unknown> }) => {
			if (cmd === 'video_mux_audio') {
				state.muxed.push(args as never);
				return { hash: 'f'.repeat(64), mime: 'video/webm', bytes: 1 };
			}
			if (cmd !== 'task_update') return null;
			state.updates.push(args.patch);
			return { id: args.id, ...args.patch };
		}
	)
);
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
	getCurrentWebviewWindow: () => ({ label: 'main' })
}));
vi.mock('#lib/videogen/index.ts', () => ({
	videoBackendForEntry: (e: { id: string; url: string; model: string }) => (
		state.builtFor.push(e),
		{
			generate: state.generate,
			resume: state.resume,
			upscale: state.upscale,
			resumeUpscale: state.resumeUpscale
		}
	)
}));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: {
			videoModels: [
				{
					id: 'v',
					name: 'ti2v',
					backend: 'llama-toolchest',
					url: 'http://box:3000',
					keyId: null,
					model: 'ti2v',
					options: {},
					caps: null,
					capsAt: null,
					renamed: false
				}
			],
			videoUpscalers: [
				{
					id: 'u',
					name: 'relayvsr-x2',
					backend: 'llama-toolchest',
					url: 'http://compute2:3000',
					keyId: null,
					model: 'relayvsr-x2',
					options: {},
					caps: null,
					capsAt: null,
					renamed: false
				}
			]
		},
		overDefaults: true
	})
);

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
	state.builtFor = [];
	state.generate.mockReset();
	state.resume.mockReset();
	state.upscale.mockReset();
	state.resumeUpscale.mockReset();
	state.muxed = [];
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

	it('names the video model in a failure', async () => {
		state.generate.mockRejectedValue(
			new ToolchestError('rejected', 'WanVideoSampler failed: out of memory')
		);
		await dispatch(task(), 'run');
		expect(state.updates.at(-1)).toEqual({
			state: 'failed',
			error: 'ti2v: WanVideoSampler failed: out of memory'
		});
	});
});

describe('the video follower, upscaling', () => {
	const input = { hash: 'd'.repeat(64), width: 832, height: 480, frames: 33, fps: 24 };
	const upSpec = (hasAudio: boolean): VideoTaskSpec => ({
		op: 'upscale',
		request: {
			title: 'Fox ×2',
			input: { ...input, hasAudio },
			upscaler: 'relayvsr-x2',
			scale: 2,
			seed: 3
		},
		notes: [],
		save: null,
		conversationId: 'c1',
		codeSessionId: null,
		entryId: 'v'
	});
	const upMade = { ...made, width: 1664, height: 960, model: 'relayvsr-x2', hasAudio: false };

	it('upscales, puts the clip’s sound back, and says what size it was', async () => {
		state.upscale.mockResolvedValue(upMade);
		await dispatch(task({ spec: upSpec(true) }), 'run');
		expect(state.generate).not.toHaveBeenCalled();
		expect(state.upscale).toHaveBeenCalledWith(upSpec(true).request, expect.anything());
		expect(state.muxed[0]).toMatchObject({ videoHash: HASH, audioHash: input.hash });
		const result = state.updates.find((u) => u.result)?.result;
		expect(result).toMatchObject({
			hash: 'f'.repeat(64),
			width: 1664,
			hasAudio: true,
			upscaledFrom: { width: 832, height: 480 }
		});
	});

	it("sends it to the upscaler's server in Settings → Video generation → Upscalers", async () => {
		state.upscale.mockResolvedValue(upMade);
		await dispatch(task({ spec: { ...upSpec(false), entryId: 'u' } }), 'run');
		expect(state.builtFor[0]).toMatchObject({
			id: 'u',
			url: 'http://compute2:3000',
			model: 'relayvsr-x2'
		});
	});

	it('says so when the upscaler was removed before it ran', async () => {
		await dispatch(task({ spec: { ...upSpec(false), entryId: 'gone' } }), 'run');
		expect(state.upscale).not.toHaveBeenCalled();
		expect(state.updates.at(-1)).toMatchObject({
			state: 'failed',
			error: expect.stringContaining('no longer in Settings → Video generation → Upscalers')
		});
	});

	it('leaves a clip without sound as it came', async () => {
		state.upscale.mockResolvedValue(upMade);
		await dispatch(task({ spec: upSpec(false) }), 'run');
		expect(state.muxed).toHaveLength(0);
	});

	it('follows an upscale job again after a restart', async () => {
		state.resumeUpscale.mockResolvedValue(upMade);
		await dispatch(task({ spec: upSpec(false), handle }), 'resume');
		expect(state.resumeUpscale).toHaveBeenCalledWith(
			handle,
			upSpec(false).request,
			expect.anything()
		);
	});
});
