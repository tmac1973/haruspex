import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
	backend: 'local',
	pending: null as string | null,
	invoke: vi.fn(),
	make: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: state.invoke }));
vi.mock('$lib/stores/settings', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/stores/settings')>();
	return {
		...actual,
		getSettings: () => ({ ...actual.getSettings(), imageBackendKind: state.backend })
	};
});
vi.mock('$lib/assets/single', () => ({
	DEFAULT_SIZE: { sprite: 64, icon: 32, texture: 128, image: 1024 },
	makeSingleAsset: state.make
}));

import { executeTool, getToolSchemas } from '$lib/agent/tools';
import type { ToolContext } from './types';
import { ImageBackendError } from '$lib/image/types';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const PALETTE = [0xff0000ff, 0x00ff00ff];

function context(over: Partial<ToolContext> = {}): ToolContext {
	return {
		workingDir: null,
		pendingImages: [],
		deepResearch: false,
		filesWrittenThisTurn: new Set(),
		shellMode: true,
		codeMode: true,
		codeAutoApprove: false,
		interactive: true,
		shellCwd: '/home/u/game',
		shellSessionId: 1,
		...over
	};
}
const names = (o: Parameters<typeof getToolSchemas>[0]) =>
	getToolSchemas(o).map((s) => s.function.name);
const calls = (cmd: string) => state.invoke.mock.calls.filter((c) => c[0] === cmd);
const writes = () => calls('fs_write_bytes_absolute').filter((c) => !c[1].dryRun);

beforeEach(() => {
	state.backend = 'local';
	state.pending = null;
	state.invoke.mockReset().mockImplementation(async (cmd: string) => {
		if (cmd === 'shell_pending_command') return state.pending;
		if (cmd === 'fs_read_bytes_absolute') return Array.from(PNG);
		if (cmd === 'image_extract_palette') return PALETTE;
		return null;
	});
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

	it('not without a backend', () => {
		state.backend = 'none';
		expect(names(code)).not.toContain('make_asset');
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
		expect(writes()[0][1]).toMatchObject({
			path: '/home/u/game/assets/coin.png',
			bytes: Array.from(PNG),
			overwrite: false
		});
		expect(out.result).toContain('Wrote /home/u/game/assets/coin.png (32×32');
		expect(out.thumbDataUrl).toMatch(/^data:image\/png;base64,/);
		expect(ctx.pendingImages).toHaveLength(1);
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
		expect(calls('fs_read_bytes_absolute')[0][1]).toMatchObject({
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
		state.invoke.mockImplementation(async (cmd: string) => {
			if (cmd === 'fs_write_bytes_absolute') throw 'File already exists: coin.png';
			return null;
		});
		const out = await executeTool(
			'make_asset',
			{ kind: 'icon', prompt: 'a coin', path: 'coin.png' },
			context()
		);
		expect(out.result).toMatch(/already exists.*overwrite: true/);
		expect(calls('fs_write_bytes_absolute')[0][1].dryRun).toBe(true);
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
