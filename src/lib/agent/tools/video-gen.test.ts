import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
	route: vi.fn(),
	backend: 'llama-toolchest',
	caps: null as Record<string, unknown> | null
}));

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore({
		task_create: (args) => ({
			id: 'video-1',
			kind: 'video',
			owner: args!.owner,
			label: args!.label,
			state: 'pending',
			follower: 'frontend',
			spec: args!.spec,
			startedMs: 1,
			noticeDelivered: false
		})
	})
);
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: () => {
			const one = {
				id: 'v',
				name: 'ti2v',
				backend: 'llama-toolchest',
				url: '',
				keyId: null,
				model: 'ti2v',
				options: {},
				caps: state.caps,
				capsAt: null,
				renamed: false
			};
			const two = { ...one, id: 'w', name: 'ltx', model: 'ltx' };
			return {
				videoModels: state.backend === 'none' ? [] : state.backend === 'two' ? [one, two] : [one]
			};
		},
		overDefaults: true
	})
);
vi.mock('#lib/videogen/route.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/videogen/route.ts')>()),
	routeVideo: state.route
}));

import { executeTool, getToolSchemas } from '#lib/agent/tools/index.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';
import { fitClip } from './video-gen.ts';
import { noticeFor } from '#lib/tasks/noticeText.ts';
import { _resetTasksForTests, getTask } from '#lib/tasks/store.svelte.ts';
import type { VideoLimits } from '#lib/toolchest/models.ts';
import type { BackgroundTask } from '#lib/tasks/types.ts';
import { invoke } from '@tauri-apps/api/core';
import { invokeArgs } from '#lib/testing/invoke.ts';
import { videoCaps } from '#lib/testing/videoModels.ts';

const limits: VideoLimits = {
	defaultFps: 24,
	defaultFrames: 33,
	defaultSize: '832x480',
	maxFrames: 121,
	maxSize: '1280x704',
	maxPixelFrames: 832 * 480 * 33,
	fixedFps: null
};

const ti2v = {
	entry: { id: 'v', name: 'ti2v' },
	backend: {},
	caps: videoCaps({ limits })
};

const chat = makeToolContext({ interactive: true, conversationId: 'c1' });

beforeEach(() => {
	_resetTasksForTests();
	state.backend = 'llama-toolchest';
	state.caps = null;
	state.route.mockReset().mockResolvedValue(ti2v);
	vi.mocked(invoke).mockReset();
});

describe('fitting a clip to the instance', () => {
	it("takes the model's own length and size when none is asked", () => {
		expect(fitClip(limits, 'ti2v', { portrait: false })).toEqual({
			width: 832,
			height: 480,
			frames: 33,
			fps: 24,
			note: null
		});
	});

	it('turns the size for portrait', () => {
		expect(fitClip(limits, 'ti2v', { portrait: true })).toMatchObject({ width: 480, height: 832 });
	});

	it('rounds a length to the frame counts Wan takes', () => {
		expect(fitClip(limits, 'ti2v', { seconds: 1, portrait: false }).frames).toBe(25);
	});

	it('shortens a clip past what the instance was measured for, and says how to allow more', () => {
		const fit = fitClip(limits, 'ti2v', { seconds: 5, portrait: false });
		expect(fit.frames).toBe(33);
		expect(fit.note).toBe(
			'Shortened to 1.4 s (33 frames): ti2v is measured for no more at 832×480; measuring it ' +
				"larger on llama-toolchest's Server page allows longer clips."
		);
	});

	it("shortens to the model's most frames when memory isn't the limit", () => {
		const fit = fitClip({ ...limits, maxPixelFrames: null }, 'ti2v', {
			seconds: 10,
			portrait: false
		});
		expect(fit.frames).toBe(121);
		expect(fit.note).toMatch(/ti2v makes at most 121 frames/);
	});
});

describe('generate_video', () => {
	it('records a task with the settled request and answers at once', async () => {
		const out = await executeTool(
			'generate_video',
			{ prompt: 'a red fox in the snow', title: 'Fox', seconds: 5, seed: 7 },
			chat
		);
		const created = invokeArgs<{ spec: { notes: string[] } }>(vi.mocked(invoke), 'task_create');
		expect(created).toMatchObject({
			kind: 'video',
			owner: 'chat:c1',
			label: 'Making Fox',
			spec: {
				request: {
					title: 'Fox',
					prompt: 'a red fox in the snow',
					width: 832,
					height: 480,
					frames: 33,
					fps: 24,
					seed: 7
				},
				save: null,
				conversationId: 'c1',
				codeSessionId: null,
				entryId: 'v'
			}
		});
		expect(created.spec.notes[0]).toMatch(/^Shortened to 1.4 s/);
		expect(out.result).toContain('Started in the background (task video-1).');
		expect(out.result).toContain('Shortened to 1.4 s');
		expect(out.result).toContain('do NOT poll');
		expect(out.artifacts).toEqual([{ kind: 'task', taskId: 'video-1', label: 'Making Fox' }]);
		expect(getTask('video-1')).toBeTruthy();
	});

	it('says why it can’t start, before recording anything', async () => {
		state.route.mockRejectedValue(new Error('ti2v is stopped — start it in llama-toolchest.'));
		const out = await executeTool('generate_video', { prompt: 'x' }, chat);
		expect(out.result).toMatch(/ti2v is stopped/);
		const bad = await executeTool('generate_video', { prompt: 'x', path: 'a.mp4' }, chat);
		expect(bad.result).toMatch(/must end in \.webm/);
		expect(vi.mocked(invoke).mock.calls.some(([c]) => c === 'task_create')).toBe(false);
	});

	it('is offered only with a backend and a chat or Code session to own the task', () => {
		const names = (o: Parameters<typeof getToolSchemas>[0]) =>
			getToolSchemas(o).map((s) => s.function.name);
		expect(names({ hasWorkingDir: false, interactive: true, taskOwner: 'chat:c1' })).toContain(
			'generate_video'
		);
		expect(names({ hasWorkingDir: false, interactive: true })).not.toContain('generate_video');
		expect(
			names({ hasWorkingDir: true, interactive: true, codeMode: true, taskOwner: 'code:s1' })
		).toContain('generate_video');
		expect(
			names({ hasWorkingDir: true, interactive: true, shellMode: true, taskOwner: 'code:s1' })
		).not.toContain('generate_video');
		state.backend = 'none';
		expect(names({ hasWorkingDir: false, interactive: true, taskOwner: 'chat:c1' })).not.toContain(
			'generate_video'
		);
	});
	it('lets the call name a model only when there are two or more', () => {
		const props = () =>
			(
				getToolSchemas({ hasWorkingDir: false, interactive: true, taskOwner: 'chat:c1' }).find(
					(s) => s.function.name === 'generate_video'
				)!.function.parameters as { properties: Record<string, { enum?: string[] }> }
			).properties;
		expect(props().model).toBeUndefined();
		state.backend = 'two';
		expect(props().model?.enum).toEqual(['ti2v', 'ltx']);
	});

	it("tells the model each video model's longest clip", () => {
		const props = () =>
			(
				getToolSchemas({ hasWorkingDir: false, interactive: true, taskOwner: 'chat:c1' }).find(
					(s) => s.function.name === 'generate_video'
				)!.function.parameters as { properties: Record<string, { description: string }> }
			).properties;
		expect(props().seconds.description).not.toContain('longest');
		state.caps = {
			text: true,
			startImage: true,
			endImage: false,
			speech: false,
			needsSpeech: false,
			sound: true,
			frameStep: 8,
			limits: {
				defaultFps: 24,
				defaultFrames: 121,
				defaultSize: '1280x704',
				maxFrames: 241,
				maxSize: '1280x704',
				maxPixelFrames: null,
				fixedFps: null
			},
			licence: '',
			commercialUse: null
		};
		expect(props().seconds.description).toContain('The longest is 10 s.');
		state.backend = 'two';
		expect(props().model.description).toContain(
			'ti2v: From a prompt or a picture · with sound · up to 10 s at 1280×704.'
		);
		expect(props().seconds.description).toContain("Each model's longest is under model.");
	});
});

describe('a finished clip’s notice', () => {
	it('places the clip, and says what changed on the way', () => {
		const hash = 'd'.repeat(64);
		const task = {
			id: 'video-1',
			kind: 'video',
			owner: 'chat:c1',
			label: 'Making Fox',
			state: 'done',
			follower: 'frontend',
			result: {
				hash,
				mime: 'video/webm',
				title: 'Fox',
				width: 832,
				height: 480,
				frames: 33,
				fps: 24,
				seed: 7,
				model: 'ti2v',
				notes: ['Shortened to 1.4 s (33 frames).'],
				saved: 'Wrote fox.webm.'
			}
		} as unknown as BackgroundTask;
		expect(noticeFor(task)).toEqual({
			text:
				'Background task "Making Fox" finished: Video ready (832×480, 1.4 s, ti2v, seed 7). ' +
				`Put ![Fox](haruspex-video://localhost/${hash}) in your answer. Wrote fox.webm. ` +
				'Shortened to 1.4 s (33 frames).',
			images: []
		});
	});

	it('asks the router for a model that can end on a picture, and passes on its refusal', async () => {
		state.route.mockRejectedValue(
			new Error('None of the video models in Settings → Video generation can end on a picture.')
		);
		const out = await executeTool(
			'generate_video',
			{ prompt: 'a fox', end_image: 'fox.png', sound: true, model: 'ti2v' },
			chat
		);
		expect(state.route).toHaveBeenCalledWith(
			{ text: true, startImage: false, endImage: true, speech: false, sound: true },
			expect.objectContaining({ named: 'ti2v' })
		);
		expect(out.result).toContain('can end on a picture');
		expect(vi.mocked(invoke).mock.calls.some(([c]) => c === 'task_create')).toBe(false);
	});

	it('says whether a finished clip has sound', () => {
		const task = {
			id: 'video-2',
			kind: 'video',
			owner: 'chat:c1',
			label: 'Making Fox',
			state: 'done',
			follower: 'frontend',
			result: {
				hash: 'a'.repeat(64),
				mime: 'video/webm',
				title: 'Fox',
				width: 832,
				height: 480,
				frames: 33,
				fps: 24,
				seed: 7,
				model: 'ltx',
				servedBy: 'ComfyUI at asmodean:8188',
				hasAudio: true,
				notes: [],
				saved: null
			}
		} as unknown as BackgroundTask;
		expect(noticeFor(task).text).toContain(
			'Video ready (832×480, 1.4 s, ltx, seed 7, with sound, backend: ComfyUI at asmodean:8188).'
		);
	});
});
