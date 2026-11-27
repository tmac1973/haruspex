/**
 * `save_generated`: save a picture, song or clip made earlier (by
 * `generate_image`, `generate_music` or `generate_video`) into the working folder: Chat's, or the Code tab's
 * project. It comes from the image or audio cache, by the URL in its
 * markdown, so it works after the server that made it has forgotten it.
 * In Chat an existing file asks the user first (`_saveGenerated.ts`).
 */
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolError, toolResult } from '#lib/agent/tools/types.ts';
import {
	generatedFromUrl,
	isSaveTarget,
	prepareSave,
	writeCached
} from '#lib/agent/tools/_saveGenerated.ts';

const EXTENSIONS = {
	image: /\.(png|jpe?g|webp|gif)$/i,
	audio: /\.(mp3|wav|ogg|flac)$/i,
	video: /\.webm$/i
};
const WANTED = { image: '.png', audio: '.mp3 or .wav', video: '.webm' };

registerTool({
	category: 'fs',
	schema: {
		type: 'function',
		function: {
			name: 'save_generated',
			description:
				'Save a picture, song or video you made earlier into the working folder, by the URL in ' +
				'its markdown.',
			parameters: {
				type: 'object',
				properties: {
					url: {
						type: 'string',
						description:
							'The haruspex-img://, haruspex-audio:// or haruspex-video:// URL of something made here.'
					},
					path: {
						type: 'string',
						description:
							'Where to save it in the working folder: .png for a picture, .mp3 or .wav for a song, .webm for a video.'
					},
					overwrite: {
						type: 'boolean',
						description:
							'Replace an existing file. Default false. In Chat the user is asked instead.'
					}
				},
				required: ['url', 'path']
			}
		}
	},
	displayLabel: (args) => `save: ${String(args.path ?? '')}`,
	execute: async (args, ctx) => {
		const made = generatedFromUrl(typeof args.url === 'string' ? args.url : '');
		if (!made) {
			return toolResult(
				toolError(
					'url must be a haruspex-img://, haruspex-audio:// or haruspex-video:// URL from something made here.'
				)
			);
		}
		const raw = typeof args.path === 'string' ? args.path.trim() : '';
		if (!EXTENSIONS[made.kind].test(raw)) {
			return toolResult(toolError(`path must end in ${WANTED[made.kind]}.`));
		}
		// Copied from the cache in Rust: an upscale or a long song is past
		// what a write from here may carry.
		const target = await prepareSave(raw, args.overwrite === true, ctx, 'save_generated');
		if (!isSaveTarget(target)) return target;
		const failed = await writeCached(target, made, ctx);
		return toolResult(failed ? toolError(failed) : `Saved ${target.path}.`);
	}
});
