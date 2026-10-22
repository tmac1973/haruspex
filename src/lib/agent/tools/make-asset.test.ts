import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
	backend: 'local',
	pending: null as string | null,
	invoke: vi.fn(),
	make: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: state.invoke }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/stores/settings.ts')>();
	return {
		...actual,
		getSettings: () => ({ ...actual.getSettings(), imageBackendKind: state.backend })
	};
});
vi.mock('#lib/assets/single.ts', () => ({
	DEFAULT_SIZE: { sprite: 64, icon: 32, image: 1024 },
	makeSingleAsset: state.make
}));

import { executeTool, getToolSchemas } from '#lib/agent/tools/index.ts';
import type { ToolContext } from './types';
import { ImageBackendError } from '#lib/image/types.ts';
import { invokeCalls, invokeRouter } from '#lib/testing/invoke.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const PALETTE = [0xff0000ff, 0x00ff00ff];

function context(over: Partial<ToolContext> = {}): ToolContext {
	return makeToolContext({
		shellMode: true,
		codeMode: true,
		interactive: true,
		shellCwd: '/home/u/game',
		shellSessionId: 1,
		...over
	});
}
const names = (o: Parameters<typeof getToolSchemas>[0]) =>
	getToolSchemas(o).map((s) => s.function.name);
const calls = (cmd: string) => invokeCalls(state.invoke, cmd);
const writes = () => calls('fs_write_bytes_absolute').filter((a) => !a?.dryRun);

beforeEach(() => {
	state.backend = 'local';
	state.pending = null;
	state.invoke.mockReset().mockImplementation(
		invokeRouter({
			shell_pending_command: () => state.pending,
			fs_read_bytes_absolute: () => Array.from(PNG),
			fs_read_bytes: () => Array.from(PNG),
			image_extract_palette: PALETTE,
			texture_validate: () => undefined,
			texture_render: (a) => Array.from({ length: Number(a?.variants) }, (_, k) => [k]),
			image_contact_sheet: [7, 7],
			texture_transition_validate: () => undefined,
			texture_transition_render: [5, 5],
			texture_transition_preview: [6, 6]
		})
	);
	state.make.mockReset().mockResolvedValue({
		bytes: PNG,
		width: 32,
		height: 32,
		checks: { passed: true, failed: [] },
		notes: [],
		seed: 5,
		model: 'ming'
	});
});

describe('make_asset is offered', () => {
	const code = { hasWorkingDir: false, shellMode: true, codeMode: true, interactive: true };

	it('in Code mode with a backend set up', () => {
		expect(names(code)).toContain('make_asset');
	});

	it('without a backend too, for textures', () => {
		state.backend = 'none';
		expect(names(code)).toContain('make_asset');
	});

	it('not when nobody is there to see the result', () => {
		expect(names({ ...code, interactive: false })).not.toContain('make_asset');
	});

	it('not in Chat, which has generate_image instead', () => {
		const chat = names({ hasWorkingDir: true, interactive: true });
		expect(chat).not.toContain('make_asset');
		expect(chat).toContain('generate_image');
		expect(names(code)).not.toContain('generate_image');
	});
});

describe('make_asset', () => {
	it('writes the asset beside the shell, and shows it to the model', async () => {
		const ctx = context();
		const out = await executeTool(
			'make_asset',
			{ kind: 'icon', prompt: 'a gold coin', path: 'assets/coin.png', size: 32 },
			ctx
		);
		expect(state.make.mock.calls[0][0]).toMatchObject({
			kind: 'icon',
			prompt: 'a gold coin',
			size: 32
		});
		expect(writes()[0]).toMatchObject({
			path: '/home/u/game/assets/coin.png',
			bytes: Array.from(PNG),
			overwrite: false
		});
		expect(out.result).toContain('Wrote /home/u/game/assets/coin.png (32×32');
		expect(out.thumbDataUrl).toMatch(/^data:image\/png;base64,/);
		expect(ctx.pendingImages).toHaveLength(1);
	});

	it("keeps a Code session's asset inside its folder", async () => {
		const ctx = context({
			shellMode: false,
			shellCwd: null,
			shellSessionId: null,
			workingDir: '/home/u/game',
			codeSessionId: 'sess-1'
		});
		await executeTool(
			'make_asset',
			{ kind: 'icon', prompt: 'a gold coin', path: 'assets/coin.png', palette_from: 'a.png' },
			ctx
		);
		// The workdir-relative commands, which refuse a path outside the folder.
		expect(calls('fs_write_bytes_absolute')).toHaveLength(0);
		expect(calls('fs_read_bytes')[0]).toMatchObject({ workdir: '/home/u/game' });
		const wrote = calls('fs_write_bytes').filter((a) => !a?.dryRun);
		expect(wrote[0]).toMatchObject({
			workdir: '/home/u/game',
			relPath: '/home/u/game/assets/coin.png'
		});
		// A WSL session's folder is reached through its distro's share.
		state.invoke.mockClear();
		await executeTool(
			'make_asset',
			{ kind: 'icon', prompt: 'a gold coin', path: 'coin.png' },
			{ ...ctx, wslDistro: 'Ubuntu' }
		);
		expect(calls('fs_write_bytes')[0]?.workdir).toBe(
			String.raw`\\wsl.localhost\Ubuntu\home\u\game`
		);
	});

	it('does not hand the picture to a model that cannot see', async () => {
		const ctx = context({ visionSupported: false });
		await executeTool('make_asset', { kind: 'sprite', prompt: 'a slime', path: 's.png' }, ctx);
		expect(ctx.pendingImages).toHaveLength(0);
	});

	it('draws in the colours of palette_from', async () => {
		await executeTool(
			'make_asset',
			{ kind: 'sprite', prompt: 'a slime', path: 's.png', palette_from: 'assets/hero.png' },
			context()
		);
		expect(calls('fs_read_bytes_absolute')[0]).toMatchObject({
			path: '/home/u/game/assets/hero.png'
		});
		expect(state.make.mock.calls[0][0].palette).toEqual(PALETTE);
	});

	it('refuses while the terminal is on another host, before drawing', async () => {
		state.pending = 'ssh pi@raspberry';
		const out = await executeTool(
			'make_asset',
			{ kind: 'icon', prompt: 'a coin', path: 'coin.png' },
			context()
		);
		expect(out.result).toMatch(/make_asset did not run/);
		expect(state.make).not.toHaveBeenCalled();
		expect(calls('fs_write_bytes_absolute')).toHaveLength(0);
	});

	it('refuses a file that exists before drawing, and says how to replace it', async () => {
		state.invoke.mockImplementation(
			invokeRouter({
				fs_write_bytes_absolute: () => {
					throw 'File already exists: coin.png';
				}
			})
		);
		const out = await executeTool(
			'make_asset',
			{ kind: 'icon', prompt: 'a coin', path: 'coin.png' },
			context()
		);
		expect(out.result).toMatch(/already exists.*overwrite: true/);
		expect(calls('fs_write_bytes_absolute')[0]?.dryRun).toBe(true);
		expect(state.make).not.toHaveBeenCalled();
	});

	it('reports failed checks so the model can decide', async () => {
		state.make.mockResolvedValueOnce({
			bytes: PNG,
			width: 64,
			height: 64,
			checks: { passed: false, failed: ['opaque background'] },
			notes: [],
			seed: 1,
			model: 'ming'
		});
		const out = await executeTool(
			'make_asset',
			{ kind: 'sprite', prompt: 'a slime', path: 's.png' },
			context()
		);
		expect(out.result).toMatch(/failed these checks: opaque background/);
	});

	it('asks for a tiling picture only for kind image', async () => {
		await executeTool(
			'make_asset',
			{ kind: 'image', prompt: 'mossy stone', path: 'm.png', seamless: true },
			context()
		);
		expect(state.make.mock.calls[0][0]).toMatchObject({ kind: 'image', seamless: true });
		await executeTool(
			'make_asset',
			{ kind: 'sprite', prompt: 'a slime', path: 's.png', seamless: true },
			context()
		);
		expect(state.make.mock.calls[1][0].seamless).toBeUndefined();
	});

	it("passes on the backend's word that a picture won't tile", async () => {
		state.make.mockResolvedValueOnce({
			bytes: PNG,
			width: 512,
			height: 512,
			checks: { passed: true, failed: [] },
			notes: ['This backend cannot make tiling textures, so the edges may not wrap.'],
			seed: 3,
			model: 'ming'
		});
		const out = await executeTool(
			'make_asset',
			{ kind: 'image', prompt: 'mossy stone', path: 'm.png', seamless: true },
			context()
		);
		expect(out.result).toMatch(/cannot make tiling textures/);
	});

	it('rejects a kind it does not make', async () => {
		const out = await executeTool(
			'make_asset',
			{ kind: 'model', prompt: 'a chair', path: 'c.glb' },
			context()
		);
		expect(out.result).toMatch(/kind must be one of/);
		expect(state.make).not.toHaveBeenCalled();
	});

	it('lets a cancel through rather than reporting it as a failure', async () => {
		state.make.mockRejectedValueOnce(new ImageBackendError('cancelled', 'stopped'));
		await expect(
			executeTool('make_asset', { kind: 'icon', prompt: 'a coin', path: 'c.png' }, context())
		).rejects.toBeInstanceOf(ImageBackendError);
	});
});

describe('make_asset textures', () => {
	const RECIPE = { base: { ramp: ['#202020', '#808080'] }, layers: [] };
	const texture = (over: Record<string, unknown> = {}) => ({
		kind: 'texture',
		prompt: 'grey gravel',
		path: 'tiles/gravel.png',
		recipe: RECIPE,
		...over
	});

	it('draws from the recipe, never the image model, and needs no backend', async () => {
		state.backend = 'none';
		const ctx = context();
		const out = await executeTool('make_asset', texture({ palette_from: 'hero.png' }), ctx);
		expect(state.make).not.toHaveBeenCalled();
		expect(calls('texture_validate')[0]).toEqual({ recipe: RECIPE });
		expect(calls('texture_render')[0]).toMatchObject({
			recipe: RECIPE,
			size: 32,
			variants: 1,
			palette: PALETTE
		});
		expect(writes()).toEqual([
			expect.objectContaining({ path: '/home/u/game/tiles/gravel.png', bytes: [0] })
		]);
		expect(out.result).toMatch(/^Wrote \/home\/u\/game\/tiles\/gravel.png \(32×32/);
		expect(ctx.pendingImages).toHaveLength(1);
	});

	it('shows the model the first tile laid 3×3', async () => {
		const out = await executeTool('make_asset', texture({ size: 16 }), context());
		const [sheet] = calls('image_contact_sheet');
		expect(sheet?.images).toEqual(Array(9).fill([0]));
		// A whole-number scale, so the copies meet exactly.
		expect(Number(sheet?.cell) % 16).toBe(0);
		expect(out.result).toMatch(/laid 3×3/);
		expect(out.thumbDataUrl).toBe(`data:image/png;base64,${btoa('\x07\x07')}`);
	});

	it('writes every variant beside the first', async () => {
		const out = await executeTool('make_asset', texture({ variants: 3 }), context());
		expect(writes().map((w) => [w?.path, w?.bytes])).toEqual([
			['/home/u/game/tiles/gravel.png', [0]],
			['/home/u/game/tiles/gravel_1.png', [1]],
			['/home/u/game/tiles/gravel_2.png', [2]]
		]);
		expect(out.result).toContain('gravel_2.png');
	});

	it('draws the same tiles for the same path', async () => {
		await executeTool('make_asset', texture(), context());
		await executeTool('make_asset', texture({ overwrite: true }), context());
		const [a, b] = calls('texture_render');
		expect(a?.seed).toBe(b?.seed);
	});

	it('asks for a recipe when there is none', async () => {
		const out = await executeTool('make_asset', texture({ recipe: undefined }), context());
		expect(out.result).toMatch(/drawn from a recipe/);
		expect(calls('texture_render')).toHaveLength(0);
	});

	it("passes Rust's refusal back, naming the field, before writing", async () => {
		state.invoke.mockImplementation(
			invokeRouter({
				texture_validate: () => {
					throw 'layers[0].color: "orange" is not a #rrggbb colour.';
				}
			})
		);
		const out = await executeTool('make_asset', texture(), context());
		expect(out.result).toMatch(/recipe was refused: layers\[0\].color/);
		expect(calls('fs_write_bytes_absolute')).toHaveLength(0);
	});

	it('refuses a sprite without a backend, and says where to set one up', async () => {
		state.backend = 'none';
		const out = await executeTool(
			'make_asset',
			{ kind: 'sprite', prompt: 'a slime', path: 's.png' },
			context()
		);
		expect(out.result).toMatch(/Settings → Image/);
		// The live run's model offered to draw the coin as a texture instead.
		expect(out.result).toMatch(/cannot draw an object/);
		expect(state.make).not.toHaveBeenCalled();
	});
});
