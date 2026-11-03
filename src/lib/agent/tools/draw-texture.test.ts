import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: state.invoke }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: () => ({ imageBackendKind: 'none' }),
		overDefaults: true
	})
);

import { executeTool, getToolSchemas } from '#lib/agent/tools/index.ts';
import { DRAW_TEXTURE_TOOL } from '#lib/agent/tools/draw-texture.ts';
import { invokeCalls, invokeRouter } from '#lib/testing/invoke.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';

const RECIPE = { base: { ramp: ['#202020', '#808080'] }, layers: [] };
const context = () =>
	makeToolContext({ codeMode: true, interactive: true, workingDir: '/home/u/game' });
const names = (o: Parameters<typeof getToolSchemas>[0]) =>
	getToolSchemas(o).map((s) => s.function.name);
const writes = () => invokeCalls(state.invoke, 'fs_write_bytes').filter((a) => !a?.dryRun);

beforeEach(() => {
	state.invoke.mockReset().mockImplementation(
		invokeRouter({
			shell_pending_command: () => null,
			texture_validate: () => undefined,
			texture_render: (a) => Array.from({ length: Number(a?.variants) }, (_, k) => [k]),
			image_contact_sheet: [7, 7]
		})
	);
});

describe('draw_texture', () => {
	it('draws a PNG from a recipe without an image backend', async () => {
		const ctx = context();
		const out = await executeTool(
			DRAW_TEXTURE_TOOL,
			{ prompt: 'bark', path: 'model/tree/textures/bark.png', recipe: RECIPE },
			ctx
		);
		expect(invokeCalls(state.invoke, 'texture_validate')[0]).toEqual({ recipe: RECIPE });
		expect(writes()).toEqual([
			expect.objectContaining({
				workdir: '/home/u/game',
				relPath: '/home/u/game/model/tree/textures/bark.png',
				bytes: [0]
			})
		]);
		expect(out.result).toMatch(/^Wrote \/home\/u\/game\/model\/tree\/textures\/bark.png \(32×32/);
	});

	it('ignores a kind and always draws a texture', async () => {
		await executeTool(
			DRAW_TEXTURE_TOOL,
			{ kind: 'sprite', prompt: 'bark', path: 'bark.png', recipe: RECIPE },
			context()
		);
		expect(writes()).toHaveLength(1);
	});

	it('refuses a path that is not a .png', async () => {
		const out = await executeTool(
			DRAW_TEXTURE_TOOL,
			{ prompt: 'bark', path: 'bark.jpg', recipe: RECIPE },
			context()
		);
		expect(out.result).toMatch(/writes a PNG/);
		expect(state.invoke).not.toHaveBeenCalledWith('texture_render', expect.anything());
		expect(writes()).toHaveLength(0);
	});

	it('refuses a call without a recipe', async () => {
		const out = await executeTool(
			DRAW_TEXTURE_TOOL,
			{ prompt: 'bark', path: 'bark.png' },
			context()
		);
		expect(out.result).toMatch(/recipe/);
		expect(writes()).toHaveLength(0);
	});
});

describe('draw_texture is offered', () => {
	it('never by the Code tab, Shell or Chat filters', () => {
		const base = { hasWorkingDir: true, interactive: true };
		expect(names({ ...base, codeMode: true, shellMode: true })).not.toContain(DRAW_TEXTURE_TOOL);
		expect(names({ ...base, codeMode: true })).not.toContain(DRAW_TEXTURE_TOOL);
		expect(names({ ...base, shellMode: true })).not.toContain(DRAW_TEXTURE_TOOL);
		expect(names(base)).not.toContain(DRAW_TEXTURE_TOOL);
	});

	it('through a job allowlist', () => {
		expect(
			names({ hasWorkingDir: true, toolAllowlist: [DRAW_TEXTURE_TOOL, 'check_3d'] })
		).toContain(DRAW_TEXTURE_TOOL);
	});
});
