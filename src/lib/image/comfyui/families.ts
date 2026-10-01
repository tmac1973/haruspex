/**
 * Which kind of model a ComfyUI request runs on, and the files that go with it.
 *
 * ComfyUI does not report a model's architecture, and the graph that runs a
 * checkpoint-style SD model cannot run a DiT that ships its text encoder and
 * VAE as separate files. So the family is read from the configured model's
 * filename, and a DiT family's companion files are found in the server's own
 * lists rather than added as three more settings the user has to fill in.
 *
 * A filename that matches no family is `sd`: that is what every model this
 * backend supported before the DiT families was, so an existing configuration
 * keeps working unchanged.
 */

import { ImageBackendError } from '../types';
import * as api from './client';

export type ModelFamily = 'sd' | 'ming' | 'qwen21';

const FAMILY_PATTERNS: Array<[ModelFamily, RegExp]> = [
	['ming', /ming[_-]?image/i],
	['qwen21', /qwen[_-]?image[_-]?2[._-]?1/i]
];

export function familyOf(model: string): ModelFamily {
	for (const [family, re] of FAMILY_PATTERNS) {
		if (re.test(model)) return family;
	}
	return 'sd';
}

/** The separate files a DiT family loads beside its diffusion model. */
export interface Companions {
	textEncoder: string;
	vae: string;
}

/**
 * What to look for, best first. Ming's w4a8 encoder comes first because it is
 * the smallest and made no difference to the output in the spike; the
 * `layer` and `pe` files are a different model and a prompt rewriter that
 * merely share the prefix.
 */
const WANTED: Record<Exclude<ModelFamily, 'sd'>, { textEncoder: RegExp[]; vae: RegExp[] }> = {
	ming: {
		textEncoder: [/^ming_image.*ling.*w4a8/i, /^ming_image.*ling.*int8/i, /^ming_image.*ling/i],
		vae: [/^ming_image.*vae/i]
	},
	qwen21: {
		textEncoder: [/^qwen3vl_8b.*int8/i, /^qwen3vl_8b.*w4a8/i, /^qwen3vl_8b/i],
		vae: [/^qwen_image_2[._]1.*vae/i]
	}
};

const NOT_A_COMPANION = /layer|_pe_/i;

/** The first name matching the first pattern that matches anything. */
export function pickCompanion(names: string[], wanted: RegExp[]): string | null {
	const candidates = names.filter((n) => !NOT_A_COMPANION.test(n));
	for (const re of wanted) {
		const hit = candidates.find((n) => re.test(n));
		if (hit) return hit;
	}
	return null;
}

/** The option list of one loader input, as `object_info` reports it. */
async function optionsOf(cfg: api.ClientConfig, cls: string, input: string): Promise<string[]> {
	const info = (await api.objectInfo(cfg, cls)) as Record<
		string,
		{ input?: { required?: Record<string, [unknown]> } }
	>;
	const names = info[cls]?.input?.required?.[input]?.[0];
	return Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : [];
}

/**
 * Resolve a family's text encoder and VAE from what the server has.
 *
 * Throws `unconfigured` naming the missing file, because a DiT graph submitted
 * without one fails validation on the server with a message about a loader
 * the user never chose.
 */
export async function resolveCompanions(
	cfg: api.ClientConfig,
	family: Exclude<ModelFamily, 'sd'>
): Promise<Companions> {
	const want = WANTED[family];
	const [encoders, vaes] = await Promise.all([
		optionsOf(cfg, 'CLIPLoader', 'clip_name'),
		optionsOf(cfg, 'VAELoader', 'vae_name')
	]);
	const textEncoder = pickCompanion(encoders, want.textEncoder);
	const vae = pickCompanion(vaes, want.vae);
	const label = family === 'ming' ? 'Ming-Image' : 'Qwen-Image-2.1';
	if (!textEncoder) {
		throw new ImageBackendError(
			'unconfigured',
			`The backend has no ${label} text encoder in models/text_encoders.`
		);
	}
	if (!vae) {
		throw new ImageBackendError('unconfigured', `The backend has no ${label} VAE in models/vae.`);
	}
	return { textEncoder, vae };
}

/** Whether the server has an acceptable text encoder and VAE for `family`, without throwing. */
export async function hasCompanions(
	cfg: api.ClientConfig,
	family: Exclude<ModelFamily, 'sd'>
): Promise<{ textEncoder: boolean; vae: boolean }> {
	const want = WANTED[family];
	const [encoders, vaes] = await Promise.all([
		optionsOf(cfg, 'CLIPLoader', 'clip_name'),
		optionsOf(cfg, 'VAELoader', 'vae_name')
	]);
	return {
		textEncoder: pickCompanion(encoders, want.textEncoder) !== null,
		vae: pickCompanion(vaes, want.vae) !== null
	};
}

/** The server's diffusion models (`models/diffusion_models`), any family. */
export async function listDiffusionModels(cfg: api.ClientConfig): Promise<string[]> {
	return optionsOf(cfg, 'UNETLoader', 'unet_name');
}

const FAMILY_LABELS: Record<ModelFamily, string> = {
	ming: 'Ming-Image',
	qwen21: 'Qwen-Image-2.1, non-commercial',
	sd: 'SD checkpoint'
};

/**
 * Every model the server has that a bundled workflow can run: the diffusion
 * models of a known DiT family, then the SD checkpoints. A diffusion model of
 * any other family is left out — it would be run as an SD checkpoint and fail.
 */
export async function listModels(
	cfg: api.ClientConfig
): Promise<Array<{ name: string; label: string; family: ModelFamily }>> {
	const [dits, checkpoints] = await Promise.all([
		optionsOf(cfg, 'UNETLoader', 'unet_name').catch(() => []),
		optionsOf(cfg, 'CheckpointLoaderSimple', 'ckpt_name').catch(() => [])
	]);
	const known = dits
		.map((name) => ({ name, family: familyOf(name) }))
		.filter((m) => m.family !== 'sd');
	const sd = checkpoints.map((name) => ({ name, family: 'sd' as const }));
	return [...known, ...sd].map((m) => ({ ...m, label: `${m.name} — ${FAMILY_LABELS[m.family]}` }));
}

/** Does the server have this diffusion model (DiT families) or checkpoint (SD)? */
export async function hasModel(
	cfg: api.ClientConfig,
	family: ModelFamily,
	name: string
): Promise<boolean | null> {
	try {
		const names =
			family === 'sd'
				? await optionsOf(cfg, 'CheckpointLoaderSimple', 'ckpt_name')
				: await optionsOf(cfg, 'UNETLoader', 'unet_name');
		// An empty list means the server would not say, not that it has none.
		return names.length === 0 ? null : names.includes(name);
	} catch {
		return null;
	}
}
