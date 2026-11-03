/**
 * `draw_texture`: `make_asset`'s texture branch as a tool of its own, for the
 * 3D models job's Allow textures box. It draws a tiling PNG by code from a
 * recipe and needs no image backend; `make_asset` would also offer sprites and
 * pictures, and an allowlist cannot narrow a tool to one kind.
 *
 * Category `'job'` keeps it out of every default toolset: a job's turn pins it
 * in through `toolAllowlist`.
 */
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolError, toolResult } from '#lib/agent/tools/types.ts';
import { drawTexture } from '#lib/agent/tools/make-asset.ts';
import { MAX_VARIANTS } from '#lib/assets/texture.ts';
import { recipeGuide } from '#lib/agent/jobs/types/asset-generation/prompts.ts';

export const DRAW_TEXTURE_TOOL = 'draw_texture';

registerTool({
	category: 'job',
	schema: {
		type: 'function',
		function: {
			name: DRAW_TEXTURE_TOOL,
			description:
				'Draw a tiling texture PNG by code from a recipe, for kit.texture() in a build ' +
				"module. Put it in the model's textures/ folder.",
			parameters: {
				type: 'object',
				properties: {
					prompt: {
						type: 'string',
						description: 'The subject, in a short phrase: "mossy cobblestones".'
					},
					path: {
						type: 'string',
						description:
							'Where to write the PNG, relative to the current directory or absolute. Its folder must exist.'
					},
					recipe: {
						type: 'object',
						description: 'How code draws it. ' + recipeGuide().join('\n')
					},
					size: {
						type: 'number',
						description: 'Edge in px: a multiple of 4 from 8 to 256, 32 by default.'
					},
					variants: {
						type: 'number',
						description: `Tiles to write, 1–${MAX_VARIANTS}, default 1. The same material with its details moved; the second is <name>_1.png.`
					},
					overwrite: { type: 'boolean', description: 'Replace an existing file. Default false.' }
				},
				required: ['prompt', 'path', 'recipe']
			}
		}
	},
	displayLabel: (args) => `draw texture: ${String(args.path ?? '')}`,
	execute: async (args, ctx) => {
		const path = typeof args.path === 'string' ? args.path.trim() : '';
		if (path && !path.toLowerCase().endsWith('.png')) {
			return toolResult(toolError(`${DRAW_TEXTURE_TOOL} writes a PNG: give path a .png name.`));
		}
		return drawTexture({ ...args, kind: 'texture' }, ctx, DRAW_TEXTURE_TOOL);
	}
});
