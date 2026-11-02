import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
	backend: 'llama-toolchest',
	invoke: vi.fn(),
	generate: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: state.invoke }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: () => ({ imageBackendKind: state.backend }),
		overDefaults: true
	})
);
vi.mock('#lib/image/forTool.ts', () => ({ generateForTool: state.generate }));

import { executeTool, getToolSchemas } from '#lib/agent/tools/index.ts';
import { editSize, resolveImage } from './_imageSource';
import { latestUserImages } from '#lib/agent/loop/context.ts';
import { ImageBackendError } from '#lib/image/types.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';
import { invokeRouter } from '#lib/testing/invoke.ts';

const SRC = 'a'.repeat(64);
const SRC_URL = `haruspex-img://localhost/${SRC}`;
const OUT = 'b'.repeat(64);
/** A 1-pixel PNG's bytes would do; the size comes from the stubbed bitmap. */
const PNG_DATA_URL = `data:image/png;base64,${btoa('PNGDATA')}`;
const sizes = vi.hoisted(() => ({ width: 1600, height: 1200 }));

const chat = makeToolContext({
	interactive: true,
	conversationId: 'chat-1',
	userImages: [PNG_DATA_URL]
});
const names = (o: Parameters<typeof getToolSchemas>[0]) =>
	getToolSchemas(o).map((s) => s.function.name);

beforeEach(() => {
	state.backend = 'llama-toolchest';
	// The webview measures a picture by decoding it; jsdom can't.
	vi.stubGlobal('createImageBitmap', async () => ({ ...sizes, close: () => {} }));
	state.invoke.mockReset().mockImplementation(
		invokeRouter({
			image_read_bytes: () => new Uint8Array([1, 2, 3]).buffer,
			fs_read_bytes: [4, 5, 6],
			image_store_bytes: OUT
		})
	);
	state.generate.mockReset().mockResolvedValue({
		bytes: new Uint8Array([9]),
		width: 1184,
		height: 880,
		seed: 3,
		model: 'klein',
		notes: []
	});
});

describe('edit_image is offered', () => {
	it('wherever generate_image is', () => {
		expect(names({ hasWorkingDir: false, interactive: true })).toContain('edit_image');
		expect(names({ hasWorkingDir: false, interactive: false })).not.toContain('edit_image');
		state.backend = 'none';
		expect(names({ hasWorkingDir: false, interactive: true })).not.toContain('edit_image');
	});
});

describe('edit_image', () => {
	it('edits the attached picture at its shape, about a megapixel', async () => {
		const out = await executeTool(
			'edit_image',
			{ image: 'attached', prompt: 'make it night' },
			chat
		);
		const [req] = state.generate.mock.calls[0];
		expect(req).toMatchObject({ prompt: 'make it night', width: 1184, height: 880 });
		expect(req.edit.images).toEqual([
			{ name: 'attached-1.png', bytes: Array.from(new TextEncoder().encode('PNGDATA')) }
		]);
		expect(out.result).toContain('Edited (1184×880, klein, seed 3).');
		expect(out.result).toContain(OUT);
	});

	it('combines a picture drawn earlier with a file in the working folder', async () => {
		const ctx = makeToolContext({ interactive: true, conversationId: 'c', workingDir: '/pics' });
		await executeTool(
			'edit_image',
			{ image: SRC_URL, also: ['cat.jpg'], prompt: 'put the cat on the sofa' },
			ctx
		);
		const [req] = state.generate.mock.calls[0];
		expect(req.edit.images).toEqual([
			{ name: 'image.png', hash: SRC },
			{ name: 'cat.jpg', bytes: [4, 5, 6] }
		]);
		expect(state.invoke).toHaveBeenCalledWith('fs_read_bytes', {
			workdir: '/pics',
			relPath: 'cat.jpg'
		});
	});

	it('says what is wrong before drawing', async () => {
		const bare = makeToolContext({ interactive: true, conversationId: 'c' });
		const cases: [Record<string, unknown>, typeof chat, RegExp][] = [
			[{ image: 'attached', prompt: 'x' }, bare, /hasn't attached a picture/],
			[{ image: 'attached:3', prompt: 'x' }, chat, /use attached:1 to attached:1/],
			[{ image: 'cat.png', prompt: 'x' }, chat, /no working folder/],
			[{ image: 'https://x.test/a.png', prompt: 'x' }, chat, /haruspex-img/],
			[{ image: 'attached' }, chat, /needs a \\?"prompt/],
			[{ image: 'attached', also: ['a', 'b', 'c', 'd'], prompt: 'x' }, chat, /at most 4/]
		];
		for (const [args, ctx, want] of cases) {
			expect((await executeTool('edit_image', args, ctx)).result).toMatch(want);
		}
		expect(state.generate).not.toHaveBeenCalled();
	});

	it('passes on why the backend can’t edit', async () => {
		state.generate.mockRejectedValue(
			new ImageBackendError('unconfigured', "Settings → Image can't edit pictures.")
		);
		const out = await executeTool('edit_image', { image: 'attached', prompt: 'x' }, chat);
		expect(out.result).toMatch(/Could not edit it: Settings → Image can't edit pictures/);
	});
});

describe('resolveImage and editSize', () => {
	it('refuses what it can’t decode', async () => {
		const got = await resolveImage('attached', 'image', chat, async () => null);
		expect(got).toBe('image could not be read as a picture.');
	});

	it('keeps the shape at about a megapixel, in 16s, never larger than the source', () => {
		expect(editSize(1600, 1200)).toEqual({ width: 1184, height: 880 });
		expect(editSize(512, 768)).toEqual({ width: 512, height: 768 });
		expect(editSize(4000, 1000)).toEqual({ width: 2048, height: 512 });
	});
});

describe('latestUserImages', () => {
	it('takes the newest user message with pictures', () => {
		const part = (url: string) => ({ type: 'image_url' as const, image_url: { url } });
		expect(
			latestUserImages([
				{ role: 'user', content: [part('old')] },
				{ role: 'user', content: [{ type: 'text', text: 'hi' }, part('a'), part('b')] },
				{ role: 'assistant', content: 'ok' },
				{ role: 'user', content: 'make it night' }
			])
		).toEqual(['a', 'b']);
		expect(latestUserImages([{ role: 'user', content: 'hi' }])).toEqual([]);
	});
});

describe('edit_image with an area', () => {
	const CANVAS = 'c'.repeat(64);
	const MASK = 'd'.repeat(64);

	beforeEach(() => {
		const plain = state.invoke.getMockImplementation()!;
		state.invoke.mockImplementation(
			invokeRouter(
				{
					image_mask_prepare: { canvas: CANVAS, mask: MASK, width: 2400, height: 1200 },
					image_mask_finish: () => new Uint8Array([7, 7]).buffer
				},
				plain
			)
		);
	});

	it('says when the part that was to change came back nearly as it was', async () => {
		const plain = state.invoke.getMockImplementation()!;
		const measured = (change: number) =>
			state.invoke.mockImplementation(invokeRouter({ image_mask_change: change }, plain));
		const args = { image: SRC_URL, prompt: 'red sky', area: { x: 0, y: 0, width: 1, height: 0.4 } };
		measured(2.5);
		const flat = await executeTool('edit_image', args, chat);
		expect(flat.result).toMatch(/came back nearly as it was/);
		const [, edited, opts] = state.invoke.mock.calls.find(([c]) => c === 'image_mask_change')!;
		expect(Array.from(edited as Uint8Array)).toEqual([9]);
		expect(opts.headers).toEqual({ 'x-canvas-hash': CANVAS, 'x-mask-hash': MASK });
		measured(40);
		expect((await executeTool('edit_image', args, chat)).result).not.toMatch(/nearly as it was/);
	});

	it('edits the canvas held to its mask, and pastes it back at the canvas’s size', async () => {
		const out = await executeTool(
			'edit_image',
			{ image: SRC_URL, prompt: 'make the sky red', area: { x: 0, y: 0, width: 1, height: 0.4 } },
			chat
		);
		const prep = state.invoke.mock.calls.find(([c]) => c === 'image_mask_prepare')![1];
		expect(prep).toEqual({
			source: { hash: SRC },
			area: { x: 0, y: 0, width: 1, height: 0.4 },
			extend: null,
			conversationId: 'chat-1'
		});
		const [req] = state.generate.mock.calls[0];
		expect(req.edit).toEqual({
			images: [{ name: 'canvas.png', hash: CANVAS }],
			mask: { name: 'mask.png', hash: MASK }
		});
		// Sized from the canvas, with the prompt as given.
		expect(req).toMatchObject({ prompt: 'make the sky red', width: 1456, height: 720 });
		const [, edited, opts] = state.invoke.mock.calls.find(([c]) => c === 'image_mask_finish')!;
		expect(Array.from(edited as Uint8Array)).toEqual([9]);
		expect(opts.headers).toEqual({ 'x-canvas-hash': CANVAS, 'x-mask-hash': MASK });
		const stored = state.invoke.mock.calls.find(([c]) => c === 'image_store_bytes')![1];
		expect(stored).toMatchObject({ bytes: [7, 7], width: 2400, height: 1200 });
		expect(out.result).toMatch(/^Edited \(2400×1200/);
	});

	it('grows the picture by inpainting the canvas, not editing it', async () => {
		await executeTool(
			'edit_image',
			{ image: SRC_URL, prompt: 'a beach at noon', extend: { left: 0.25, right: 0.25 } },
			chat
		);
		const prep = state.invoke.mock.calls.find(([c]) => c === 'image_mask_prepare')![1];
		expect(prep).toMatchObject({
			area: null,
			extend: { left: 0.25, right: 0.25, top: 0, bottom: 0 }
		});
		const [req] = state.generate.mock.calls[0];
		expect(req.edit).toBeUndefined();
		expect(req).toMatchObject({
			prompt: 'a beach at noon',
			width: 1456,
			height: 720,
			inpaint: {
				image: { name: 'canvas.png', hash: CANVAS },
				mask: { name: 'mask.png', hash: MASK }
			}
		});
		expect(state.invoke.mock.calls.some(([c]) => c === 'image_mask_finish')).toBe(true);
	});

	it('says what is wrong with an area before drawing', async () => {
		for (const [args, said] of [
			[{ area: { x: 0.5, y: 0, width: 2, height: 1 } }, /area.width must be a fraction/],
			[{ area: { x: 0, y: 0, width: 0, height: 1 } }, /area needs a width and a height/],
			[{ area: 'top half' }, /area must be an object/],
			[{ extend: { left: 0 } }, /at least one side/],
			[{ extend: { right: 3 } }, /extend.right must be a fraction/]
		] as const) {
			const out = await executeTool('edit_image', { image: SRC_URL, prompt: 'x', ...args }, chat);
			expect(out.result).toMatch(said);
		}
		expect(state.generate).not.toHaveBeenCalled();
	});
});
