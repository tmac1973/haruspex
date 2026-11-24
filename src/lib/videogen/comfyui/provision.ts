/**
 * Which of a video family's files a ComfyUI server lacks, for Settings →
 * Video generation's Install. The routes that put them there are the image
 * ones (`#lib/image/comfyui/provision.ts`); only this question differs.
 *
 * A file counts as there when the server lists it by name, or when the
 * family's workflow would find something else that does its job (another
 * build of the umt5 text encoder, say), as `resolveCompanions` judges it.
 */
import type { ComfyModelFile } from '#lib/ipc/gen/ComfyModelFile.ts';
import type { ComfyModelSet } from '#lib/ipc/gen/ComfyModelSet.ts';
import * as api from '#lib/comfyui/client.ts';
import { optionsOf } from '#lib/comfyui/nodes.ts';
import {
	WANTED,
	listVideoModels,
	resolveCompanions,
	type VideoFamily
} from '#lib/videogen/comfyui/families.ts';

/** The loader input that lists each folder's files. */
const LISTED_BY: Record<ComfyModelFile['folder'], [string, string]> = {
	diffusion_models: ['UNETLoader', 'unet_name'],
	text_encoders: ['CLIPLoader', 'clip_name'],
	vae: ['VAELoader', 'vae_name'],
	loras: ['LoraLoaderModelOnly', 'lora_name'],
	upscale_models: ['UpscaleModelLoader', 'model_name'],
	audio_encoders: ['AudioEncoderLoader', 'audio_encoder_name'],
	checkpoints: ['CheckpointLoaderSimple', 'ckpt_name'],
	latent_upscale_models: ['LatentUpscaleModelLoader', 'model_name']
};

const base = (name: string) => name.replace(/^.*[\\/]/, '');

export async function missingVideoFiles(
	cfg: api.ClientConfig,
	set: ComfyModelSet
): Promise<ComfyModelFile[]> {
	const family = set.family as VideoFamily;
	const [models, companions] = await Promise.all([
		listVideoModels(cfg),
		resolveCompanions(cfg, family)
	]);
	const lists = new Map<string, Promise<string[]>>();
	const listOf = (folder: ComfyModelFile['folder']) => {
		const [cls, input] = LISTED_BY[folder];
		if (!lists.has(folder)) {
			lists.set(
				folder,
				optionsOf(cfg, cls, input).then((names) => names.map(base))
			);
		}
		return lists.get(folder)!;
	};
	const out: ComfyModelFile[] = [];
	for (const f of set.files) {
		if ((await listOf(f.folder)).includes(f.filename)) continue;
		// Another file doing this one's job: the family's own model, or a companion found by pattern.
		const role = Object.entries(WANTED[family]).find(([, w]) =>
			w.patterns.some((re) => re.test(f.filename))
		)?.[0];
		if (role && companions.found[role]) continue;
		const isModel = !role && models.some((m) => m.family === family);
		if (isModel) continue;
		out.push(f);
	}
	return out;
}
