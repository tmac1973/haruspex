import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
	invoke: vi.fn(),
	generate: vi.fn(),
	resume: vi.fn(),
	upscale: vi.fn(),
	register: vi.fn((hash: string) => `haruspex-img://localhost/${hash}`)
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: state.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/stores/settings.ts')>();
	return {
		...actual,
		getSettings: () => ({ ...actual.getSettings(), imageBackendKind: 'comfyui' })
	};
});
vi.mock('#lib/image/forTool.ts', () => ({
	generateForTool: state.generate,
	resumeForTool: state.resume,
	upscaleForTool: state.upscale
}));
vi.mock('#lib/images/resolve.svelte.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/images/resolve.svelte.ts')>()),
	registerLocalImage: state.register
}));

import { executeTool, getToolSchemas } from '#lib/agent/tools/index.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';
import { runImageJob, type ImageTaskSpec } from './_imageJob.ts';
import { _resetTasksForTests, getTask } from '#lib/tasks/store.svelte.ts';

const drawn = {
	bytes: new Uint8Array([1, 2, 3]),
	width: 1024,
	height: 768,
	seed: 7,
	model: 'ming',
	notes: ['A note.']
};

function spec(over: Partial<ImageTaskSpec> = {}): ImageTaskSpec {
	return {
		job: {
			op: 'draw',
			request: { prompt: 'a fox', width: 1024, height: 768, seed: null },
			alt: 'a fox',
			verb: 'Image ready'
		},
		save: null,
		conversationId: 'c1',
		visionSupported: true,
		...over
	};
}

beforeEach(() => {
	_resetTasksForTests();
	for (const f of [state.invoke, state.generate, state.resume, state.upscale]) f.mockReset();
	state.register.mockClear();
	state.generate.mockResolvedValue(drawn);
	state.resume.mockResolvedValue(drawn);
	state.invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
		if (cmd === 'image_store_bytes') return 'stored';
		if (cmd === 'image_mask_finish') return new Uint8Array([9]).buffer;
		if (cmd === 'image_store_upscaled') return { hash: 'big', width: 4096, height: 3072 };
		if (cmd === 'task_create') {
			return {
				id: 'image-1',
				kind: 'image',
				owner: args.owner,
				label: args.label,
				state: 'pending',
				follower: 'frontend',
				spec: args.spec,
				startedMs: 1,
				noticeDelivered: false
			};
		}
		return null;
	});
});

describe('runImageJob', () => {
	it('draws, keeps the picture with its chat, and says what it made', async () => {
		const onHandle = vi.fn();
		const out = await runImageJob(spec(), { onHandle });
		expect(state.generate).toHaveBeenCalledWith(
			expect.objectContaining({ prompt: 'a fox' }),
			expect.objectContaining({ onHandle })
		);
		expect(state.invoke).toHaveBeenCalledWith('image_store_bytes', {
			bytes: [1, 2, 3],
			mime: 'image/png',
			width: 1024,
			height: 768,
			conversationId: 'c1'
		});
		expect(state.register).toHaveBeenCalledWith('stored', expect.anything());
		expect(out).toEqual({
			op: 'draw',
			hash: 'stored',
			width: 1024,
			height: 768,
			model: 'ming',
			seed: 7,
			alt: 'a fox',
			verb: 'Image ready',
			notes: ['A note.'],
			saved: null
		});
	});

	it('follows a job an earlier run sent, from its handle', async () => {
		const handle = {
			backend: 'comfyui' as const,
			baseUrl: 'http://gpu:8188',
			id: 'p1',
			seed: 7,
			model: 'ming',
			width: 1024,
			height: 768
		};
		await runImageJob(spec(), {}, handle);
		expect(state.resume).toHaveBeenCalledWith(handle, expect.anything());
		expect(state.generate).not.toHaveBeenCalled();
	});

	it('pastes a masked edit over its canvas, at the canvas size', async () => {
		const masked = { canvas: 'cv', mask: 'mk', width: 2000, height: 1500 };
		const job = { ...spec().job, masked } as ImageTaskSpec['job'];
		const out = await runImageJob(spec({ job }), {});
		expect(state.invoke).toHaveBeenCalledWith('image_mask_finish', drawn.bytes, {
			headers: { 'x-canvas-hash': 'cv', 'x-mask-hash': 'mk' }
		});
		expect(out).toMatchObject({ width: 2000, height: 1500 });
	});

	it('upscales by hash and saves where the chat asked', async () => {
		state.upscale.mockResolvedValue(new Uint8Array([5]));
		const out = await runImageJob(
			spec({
				job: { op: 'upscale', sourceHash: 'src', width: 4096, height: 3072 },
				save: { mode: 'chat', workdir: '/w', path: 'big.png', overwrite: false }
			}),
			{}
		);
		expect(state.upscale).toHaveBeenCalledWith({ name: 'image.png', hash: 'src' }, {});
		expect(state.invoke).toHaveBeenCalledWith('fs_save_cached_image', {
			hash: 'big',
			workdir: '/w',
			relPath: 'big.png',
			overwrite: false
		});
		expect(out).toMatchObject({ op: 'upscale', hash: 'big', saved: 'Wrote big.png.' });
	});
});

describe('background: true', () => {
	const chat = makeToolContext({ interactive: true, conversationId: 'c1' });

	it('records a task with the job and answers at once, without drawing', async () => {
		const out = await executeTool(
			'generate_image',
			{ prompt: 'a red fox in the snow', background: true },
			chat
		);
		expect(state.generate).not.toHaveBeenCalled();
		expect(state.invoke).toHaveBeenCalledWith(
			'task_create',
			expect.objectContaining({
				kind: 'image',
				owner: 'chat:c1',
				label: 'Drawing a red fox in the snow',
				spec: expect.objectContaining({
					conversationId: 'c1',
					job: expect.objectContaining({ op: 'draw', verb: 'Image ready' })
				})
			})
		);
		expect(out.result).toContain('Started in the background (task image-1)');
		expect(out.result).toContain('do NOT poll');
		expect(out.artifacts).toEqual([
			{ kind: 'task', taskId: 'image-1', label: 'Drawing a red fox in the snow' }
		]);
		expect(getTask('image-1')).toBeTruthy();
	});

	it('draws as before without it, or with no chat to own a task', async () => {
		const out = await executeTool(
			'generate_image',
			{ prompt: 'a fox', background: true },
			makeToolContext({ interactive: true })
		);
		expect(state.generate).toHaveBeenCalled();
		expect(out.result).toContain('Image ready');
	});

	it('is offered only where a task can have an owner', () => {
		const params = (taskOwner?: string) =>
			getToolSchemas({ hasWorkingDir: false, interactive: true, taskOwner }).find(
				(s) => s.function.name === 'generate_image'
			)?.function.parameters as { properties: Record<string, unknown> };
		expect(params('chat:c1').properties.background).toBeTruthy();
		expect(params(undefined).properties.background).toBeUndefined();
	});
});
