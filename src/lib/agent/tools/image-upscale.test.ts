import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
	backend: 'local',
	invoke: vi.fn(),
	upscale: vi.fn(),
	size: { width: 512, height: 384 }
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: state.invoke }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: () => ({ imageBackendKind: state.backend }),
		overDefaults: true
	})
);
vi.mock('#lib/image/forTool.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/image/forTool.ts')>()),
	upscaleForTool: state.upscale
}));

import { executeTool, getToolSchemas } from '#lib/agent/tools/index.ts';
import { targetSize } from './image-upscale';
import { ImageBackendError } from '#lib/image/types.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';

const SRC = 'a'.repeat(64);
const SRC_URL = `haruspex-img://localhost/${SRC}`;
const OUT = 'c'.repeat(64);
const chat = makeToolContext({ interactive: true, conversationId: 'chat-1' });
const names = (o: Parameters<typeof getToolSchemas>[0]) =>
	getToolSchemas(o).map((s) => s.function.name);

beforeEach(() => {
	state.backend = 'local';
	state.size = { width: 512, height: 384 };
	vi.stubGlobal('createImageBitmap', async () => ({ ...state.size, close: () => {} }));
	state.invoke.mockReset().mockImplementation(async (cmd: string, args: unknown) => {
		if (cmd === 'image_read_bytes') return new Uint8Array([1, 2, 3]).buffer;
		if (cmd === 'fs_read_bytes') return [4, 5, 6];
		if (cmd === 'image_store_bytes') return SRC;
		if (cmd === 'image_store_upscaled') {
			const headers = (state.invoke.mock.calls.at(-1)?.[2] as { headers: Record<string, string> })
				.headers;
			return { hash: OUT, width: Number(headers['x-width']), height: Number(headers['x-height']) };
		}
		return args ?? null;
	});
	state.upscale.mockReset().mockResolvedValue(new Uint8Array([9, 9, 9]));
});

describe('upscale_image is offered', () => {
	it('wherever generate_image is', () => {
		expect(names({ hasWorkingDir: false, interactive: true })).toContain('upscale_image');
		state.backend = 'none';
		expect(names({ hasWorkingDir: false, interactive: true })).not.toContain('upscale_image');
	});
});

describe('targetSize', () => {
	it('scales, and brings a result over 4096 px down to fit, saying so', () => {
		expect(targetSize(512, 384, 4)).toEqual({ width: 2048, height: 1536 });
		expect(targetSize(512, 384, 2)).toEqual({ width: 1024, height: 768 });
		expect(targetSize(1344, 768, 4)).toMatchObject({
			width: 4096,
			height: 2341,
			note: expect.stringContaining('the most it makes')
		});
		expect(targetSize(3000, 2000, 2)).toMatch(/up to 2048 px can be upscaled/);
	});
});

describe('upscale_image', () => {
	it('upscales a picture drawn earlier and keeps the result at the size asked for', async () => {
		const out = await executeTool('upscale_image', { image: SRC_URL, scale: 2 }, chat);
		expect(state.upscale.mock.calls[0][0]).toEqual({ name: 'image.png', hash: SRC });
		const [cmd, body, opts] = state.invoke.mock.calls.find(([c]) => c === 'image_store_upscaled')!;
		expect(cmd).toBe('image_store_upscaled');
		expect(Array.from(body as Uint8Array)).toEqual([9, 9, 9]);
		expect(opts).toEqual({
			headers: {
				'x-width': '1024',
				'x-height': '768',
				'x-source-hash': SRC,
				'x-conversation-id': 'chat-1'
			}
		});
		expect(out.result).toContain('Upscaled to 1024×768.');
		expect(out.result).toContain(OUT);
	});

	it('keeps a working-folder file in the cache first, so its alpha can be put back', async () => {
		const ctx = makeToolContext({ interactive: true, conversationId: 'c', workingDir: '/pics' });
		await executeTool('upscale_image', { image: 'sprite.png' }, ctx);
		expect(state.invoke).toHaveBeenCalledWith('image_store_bytes', {
			bytes: [4, 5, 6],
			mime: 'image/png',
			width: 512,
			height: 384,
			conversationId: 'c'
		});
		expect(state.upscale.mock.calls[0][0]).toEqual({ name: 'image.png', hash: SRC });
	});

	it('refuses a picture too large, before upscaling', async () => {
		state.size = { width: 3000, height: 2000 };
		const out = await executeTool('upscale_image', { image: SRC_URL }, chat);
		expect(out.result).toMatch(/up to 2048 px can be upscaled/);
		expect(state.upscale).not.toHaveBeenCalled();
	});

	it('passes on why the backend can’t upscale', async () => {
		state.upscale.mockRejectedValue(
			new ImageBackendError('unconfigured', "Settings → Image can't upscale pictures.")
		);
		const out = await executeTool('upscale_image', { image: SRC_URL }, chat);
		expect(out.result).toMatch(/Could not upscale it: Settings → Image can't upscale pictures/);
	});
});
