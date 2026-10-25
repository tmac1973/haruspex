/**
 * `save_audio`: save a song made earlier (by `generate_music`, in this chat or
 * Code session) into the working folder: Chat's, or the Code tab's project.
 * The song comes from the audio cache, so it works after the server that made
 * it has forgotten it. `generate_music`'s own `path` saves one as it is made.
 */
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolError, toolResult } from '#lib/agent/tools/types.ts';
import { audioHashFromUrl } from '#lib/audio/url.ts';
import { songTarget, writeSong } from '#lib/agent/tools/music-gen.ts';

registerTool({
	category: 'fs',
	schema: {
		type: 'function',
		function: {
			name: 'save_audio',
			description:
				'Save a song you made earlier into the working folder, by the haruspex-audio URL its ' +
				'player line has.',
			parameters: {
				type: 'object',
				properties: {
					url: {
						type: 'string',
						description: 'The song’s haruspex-audio://localhost/… URL, from generate_music.'
					},
					path: {
						type: 'string',
						description: 'Where to save it in the working folder, ending .mp3 or .wav.'
					},
					overwrite: { type: 'boolean', description: 'Replace an existing file. Default false.' }
				},
				required: ['url', 'path']
			}
		}
	},
	displayLabel: (args) => `save song: ${String(args.path ?? '')}`,
	execute: async (args, ctx) => {
		const hash = audioHashFromUrl(typeof args.url === 'string' ? args.url : '');
		if (!hash) {
			return toolResult(
				toolError('url must be a song’s haruspex-audio://localhost/… URL from generate_music.')
			);
		}
		const raw = typeof args.path === 'string' ? args.path.trim() : '';
		if (!/\.(mp3|wav)$/i.test(raw)) return toolResult(toolError('path must end in .mp3 or .wav.'));
		const target = await songTarget(raw, args.overwrite === true, ctx);
		if ('refusal' in target) return toolResult(toolError(target.refusal));
		try {
			const failed = await writeSong(hash, target.path, args.overwrite === true, ctx);
			return toolResult(failed ? toolError(failed) : `Saved ${target.path}.`);
		} catch {
			return toolResult(
				toolError('That song is no longer in the audio cache; make it again with generate_music.')
			);
		}
	}
});
