import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
	backend: 'comfyui',
	invoke: vi.fn(),
	generate: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: state.invoke }));
vi.mock('$lib/stores/settings', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/stores/settings')>();
	return {
		...actual,
		getSettings: () => ({ ...actual.getSettings(), imageBackendKind: state.backend })
	};
});
vi.mock('$lib/image/forTool', () => ({ generateForTool: state.generate }));

import { executeTool, getToolSchemas } from '$lib/agent/tools';
import type { ToolContext } from './types';
import { ImageBackendError } from '$lib/image/types';

const HASH = 'b'.repeat(64);
const ctx: ToolContext = {
	workingDir: null,
	pendingImages: [],
	deepResearch: false,
	filesWrittenThisTurn: new Set(),
	shellMode: false,
	codeMode: false,
	codeAutoApprove: false,
	interactive: true,
	conversationId: 'chat-1'
};
const names = (o: Parameters<typeof getToolSchemas>[0]) =>
	getToolSchemas(o).map((s) => s.function.name);

beforeEach(() => {
	state.backend = 'comfyui';
	state.invoke.mockReset().mockResolvedValue(HASH);
	state.generate.mockReset().mockResolvedValue({
		bytes: new Uint8Array([1, 2]),
		width: 1024,
		height: 1024,
		seed: 9,
		model: 'ming',
		notes: []
	});
});

describe('generate_image is offered', () => {
	it('in Chat, with a backend set up and someone there', () => {
		expect(names({ hasWorkingDir: false, interactive: true })).toContain('generate_image');
	});

	it('not to a job, which runs the Chat filter with nobody there', () => {
		// A research job has no allowlist; it must not spend GPU minutes drawing for nobody.
		expect(names({ hasWorkingDir: false, interactive: false })).not.toContain('generate_image');
	});

	it('not when no backend is set up', () => {
		state.backend = 'none';
		expect(names({ hasWorkingDir: false, interactive: true })).not.toContain('generate_image');
	});
});

describe('generate_image', () => {
	it('stores the picture with the conversation and gives the model its markdown', async () => {
		const out = await executeTool('generate_image', { prompt: 'a lighthouse at dusk' }, ctx);
		expect(state.invoke).toHaveBeenCalledWith(
			'image_store_bytes',
			expect.objectContaining({ conversationId: 'chat-1', mime: 'image/png' })
		);
		expect(out.result).toMatch(new RegExp(`!\\[a lighthouse at dusk\\]\\([^)]*${HASH}\\)`));
		expect(out.result).toContain('seed 9');
	});

	it('draws the shape asked for', async () => {
		await executeTool('generate_image', { prompt: 'a road', shape: 'landscape' }, ctx);
		expect(state.generate.mock.calls[0][0]).toMatchObject({ width: 1344, height: 768 });
	});

	it('refuses when nobody is there, whatever the schema said', async () => {
		const out = await executeTool(
			'generate_image',
			{ prompt: 'x' },
			{ ...ctx, interactive: false }
		);
		expect(out.result).toMatch(/only available in a conversation/);
		expect(state.generate).not.toHaveBeenCalled();
	});

	it('tells the model why a draw failed', async () => {
		state.generate.mockRejectedValueOnce(new ImageBackendError('unreachable', 'ComfyUI is down'));
		const out = await executeTool('generate_image', { prompt: 'x' }, ctx);
		expect(out.result).toContain('ComfyUI is down');
	});

	it('lets a cancel through as a cancel', async () => {
		state.generate.mockRejectedValueOnce(
			new ImageBackendError('cancelled', 'Generation cancelled.')
		);
		await expect(executeTool('generate_image', { prompt: 'x' }, ctx)).rejects.toMatchObject({
			kind: 'cancelled'
		});
	});
});
