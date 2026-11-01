import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ImageBackendCapabilities, ImageModelEntry } from '#lib/image/types.ts';

const state = vi.hoisted(() => ({
	models: [] as unknown[],
	invoke: vi.fn(),
	generate: vi.fn(),
	upscale: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: state.invoke }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: () => ({ imageModels: state.models }),
		overDefaults: true
	})
);
vi.mock('#lib/image/forTool.ts', () => ({
	generateForTool: state.generate,
	upscaleForTool: state.upscale
}));

import { executeTool, getToolSchemas } from '#lib/agent/tools/index.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';
import { invokeRouter } from '#lib/testing/invoke.ts';

const DRAWS: ImageBackendCapabilities = {
	transparency: true,
	seamlessTiling: false,
	loras: false,
	maxLoras: 0
};

function model(name: string, caps: Partial<ImageBackendCapabilities> | null): ImageModelEntry {
	return {
		id: name,
		name,
		backend: 'llama-toolchest',
		url: 'http://asmodean:3000',
		keyId: null,
		model: name,
		options: {},
		caps: caps && { ...DRAWS, ...caps },
		capsAt: caps && 1,
		renamed: false
	};
}

const ming = model('Ming sprites', {});
const klein = model('klein', { edit: true, maxEditImages: 4, upscale: true });
const flux3 = model('FLUX.3 Image Klein', { edit: true, maxEditImages: 10 });

const SRC = 'a'.repeat(64);
const SRC_URL = `haruspex-img://localhost/${SRC}`;
const chat = makeToolContext({ interactive: true, conversationId: 'chat-1' });

function schemas() {
	return getToolSchemas({ hasWorkingDir: false, interactive: true });
}
const names = () => schemas().map((s) => s.function.name);
function params(tool: string) {
	const schema = schemas().find((s) => s.function.name === tool);
	return (schema!.function.parameters as { properties: Record<string, Record<string, unknown>> })
		.properties;
}

beforeEach(() => {
	state.models = [];
	vi.stubGlobal('createImageBitmap', async () => ({ width: 1024, height: 1024, close: () => {} }));
	state.invoke.mockReset().mockImplementation(
		invokeRouter({
			image_read_bytes: () => new Uint8Array([1, 2, 3]).buffer,
			image_store_bytes: () => 'b'.repeat(64)
		})
	);
	state.generate.mockReset().mockResolvedValue({
		bytes: new Uint8Array([9]),
		width: 1024,
		height: 1024,
		seed: 3,
		model: 'klein',
		notes: []
	});
	state.upscale.mockReset().mockRejectedValue(new Error('stop here'));
});

describe('the image tools offered', () => {
	it('leaves out editing and upscaling when no model can', () => {
		state.models = [ming];
		expect(names()).toContain('generate_image');
		expect(names()).not.toContain('edit_image');
		expect(names()).not.toContain('upscale_image');
	});

	it('offers each once a model can', () => {
		state.models = [ming, model('editor', { edit: true, maxEditImages: 2 })];
		expect(names()).toContain('edit_image');
		expect(names()).not.toContain('upscale_image');
		state.models = [ming, klein];
		expect(names()).toContain('upscale_image');
	});

	it('offers both for a model no probe has answered for', () => {
		state.models = [ming, model('new', null)];
		expect(names()).toContain('edit_image');
		expect(names()).toContain('upscale_image');
	});
});

describe('the model argument', () => {
	it('is there only with two or more models, naming them', () => {
		state.models = [klein];
		expect(params('generate_image').model).toBeUndefined();
		expect(params('edit_image').model).toBeUndefined();
		state.models = [ming, klein];
		expect(params('generate_image').model).toMatchObject({ enum: ['Ming sprites', 'klein'] });
		expect(params('upscale_image').model).toMatchObject({ enum: ['Ming sprites', 'klein'] });
	});

	it('is passed on to the router', async () => {
		state.models = [ming, klein];
		await executeTool('generate_image', { prompt: 'a fox', model: 'klein' }, chat);
		expect(state.generate.mock.calls[0][1]).toMatchObject({ named: 'klein' });
		await executeTool('upscale_image', { image: SRC_URL, model: 'klein' }, chat);
		expect(state.upscale.mock.calls[0][1]).toMatchObject({ named: 'klein' });
	});

	it('sends a background task to the model named, not the first that can', async () => {
		state.models = [ming, klein];
		state.invoke.mockImplementation(
			invokeRouter({
				task_create: (args) => ({
					id: 'image-1',
					kind: 'image',
					owner: 'chat:chat-1',
					label: args!.label
				})
			})
		);
		await executeTool(
			'generate_image',
			{ prompt: 'a fox', model: 'klein', background: true },
			chat
		);
		expect(state.invoke).toHaveBeenCalledWith(
			'task_create',
			expect.objectContaining({
				spec: expect.objectContaining({ named: 'klein', entry: klein })
			})
		);
	});

	it('is left to the router when not given', async () => {
		state.models = [ming, klein];
		await executeTool('generate_image', { prompt: 'a fox' }, chat);
		expect(state.generate.mock.calls[0][1].named).toBeUndefined();
	});
});

describe('how many pictures edit_image combines', () => {
	const ten = { image: SRC_URL, also: Array(9).fill(SRC_URL), prompt: 'a group photo' };

	it('follows the most able model', () => {
		state.models = [klein, flux3];
		expect(params('edit_image').also).toMatchObject({ maxItems: 9 });
		expect(params('edit_image').also.description).toMatch(/Up to 9 more/);
		state.models = [klein];
		expect(params('edit_image').also).toMatchObject({ maxItems: 3 });
	});

	it('has no also when the most able takes one picture', () => {
		state.models = [model('single', { edit: true, maxEditImages: 1 })];
		expect(params('edit_image').also).toBeUndefined();
	});

	it('runs ten with a model that takes ten', async () => {
		state.models = [klein, flux3];
		const out = await executeTool('edit_image', ten, chat);
		expect(out.result).toContain('Edited');
		expect(state.generate.mock.calls[0][0].edit.images).toHaveLength(10);
	});

	it('refuses ten before any request when no model takes them', async () => {
		state.models = [klein];
		const out = await executeTool('edit_image', ten, chat);
		expect(out.result).toMatch(/at most 4 pictures with the image models in Settings → Image/);
		expect(state.generate).not.toHaveBeenCalled();
	});
});
