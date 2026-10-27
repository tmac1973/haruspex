import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
	backend: 'local',
	pending: null as string | null,
	invoke: vi.fn(),
	make: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: state.invoke }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: () => ({ imageBackendKind: state.backend }),
		overDefaults: true
	})
);
vi.mock('#lib/assets/single.ts', () => ({
	DEFAULT_SIZE: { sprite: 64, icon: 32, image: 1024 },
	makeSingleAsset: state.make
}));

import { executeTool } from '#lib/agent/tools/index.ts';
import type { ToolContext } from './types';
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

describe('make_asset transitions', () => {
	const GRASS = { base: { ramp: ['#304020', '#405030'] }, layers: [] };
	const DIRT = { base: { ramp: ['#403020', '#504030'] }, layers: [] };
	const top = (over: Record<string, unknown> = {}) => ({
		kind: 'transition',
		prompt: 'grass meeting dirt',
		path: 'tiles/grass_dirt.png',
		view: 'top',
		recipe: GRASS,
		recipe_b: DIRT,
		...over
	});
	const bytesOf = (w: Record<string, unknown> | undefined) =>
		new TextDecoder().decode(new Uint8Array(w?.bytes as number[]));

	it('writes the sheet and its JSON map, and shows the model the map', async () => {
		state.backend = 'none';
		const ctx = context();
		const out = await executeTool('make_asset', top(), ctx);
		expect(calls('texture_transition_render')[0]).toMatchObject({
			view: 'top',
			a: GRASS,
			other: DIRT,
			size: 32
		});
		const [sheet, json] = writes();
		expect(sheet).toMatchObject({ path: '/home/u/game/tiles/grass_dirt.png', bytes: [5, 5] });
		expect(json?.path).toBe('/home/u/game/tiles/grass_dirt.json');
		const map = JSON.parse(bytesOf(json));
		expect(map).toMatchObject({ view: 'top', a: 'a', b: 'b', columns: 4 });
		expect(map.tiles).toHaveLength(16);
		expect(out.result).toMatch(/Wrote .*grass_dirt\.png and .*grass_dirt\.json/);
		expect(ctx.pendingImages).toHaveLength(1);
		expect(state.make).not.toHaveBeenCalled();
	});

	it('draws a side set with a cap, or without one', async () => {
		await executeTool(
			'make_asset',
			top({ view: 'side', recipe_b: undefined, cap: GRASS, recipe: DIRT }),
			context()
		);
		expect(calls('texture_transition_render')[0]).toMatchObject({ view: 'side', other: GRASS });
		expect(JSON.parse(bytesOf(writes()[1]))).toMatchObject({ a: 'solid', cap: 'cap' });
		state.invoke.mockClear();
		await executeTool(
			'make_asset',
			top({ view: 'side', recipe_b: undefined, recipe: DIRT, overwrite: true }),
			context()
		);
		expect(calls('texture_transition_render')[0]?.other).toBeNull();
	});

	it('names what is missing before writing anything', async () => {
		for (const [over, want] of [
			[{ recipe_b: undefined }, /recipe_b/],
			[{ view: undefined }, /needs \\"view\\"/],
			[{ recipe: undefined }, /first material/]
		] as const) {
			const out = await executeTool('make_asset', top(over), context());
			expect(out.result).toMatch(want);
		}
		expect(calls('fs_write_bytes_absolute')).toHaveLength(0);
	});

	it('names which recipe Rust refused', async () => {
		state.invoke.mockImplementation(
			invokeRouter({
				texture_validate: (a: Record<string, unknown> | undefined) => {
					if (a?.recipe === DIRT) throw 'base.ramp: give 2 to 8 colours';
				}
			})
		);
		const out = await executeTool('make_asset', top(), context());
		expect(out.result).toMatch(/recipe_b was refused: base\.ramp/);
		expect(calls('fs_write_bytes_absolute')).toHaveLength(0);
	});

	it("seeds each material from its texture's file, so the plain tiles match it", async () => {
		await executeTool(
			'make_asset',
			top({ seed_from: 'tiles/grass.png', seed_from_b: 'tiles/dirt.png' }),
			context()
		);
		await executeTool(
			'make_asset',
			{ kind: 'texture', prompt: 'g', path: 'tiles/grass.png', recipe: GRASS },
			context()
		);
		await executeTool(
			'make_asset',
			{ kind: 'texture', prompt: 'd', path: 'tiles/dirt.png', recipe: DIRT },
			context()
		);
		const set = calls('texture_transition_render')[0];
		const [grass, dirt] = calls('texture_render');
		expect(set?.seedA).toBe(grass?.seed);
		expect(set?.seedOther).toBe(dirt?.seed);
	});
});
