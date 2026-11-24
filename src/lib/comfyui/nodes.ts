/**
 * What a ComfyUI server has, read from its node definitions: the options of
 * one loader input (the model files in one folder), and the first of them
 * that matches what a workflow wants.
 */
import * as api from '#lib/comfyui/client.ts';

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

/**
 * The option list of one loader input, as `object_info` reports it: a bare
 * list, or `["COMBO", {options}]` from a node on ComfyUI's newer node API
 * (`UpscaleModelLoader` on 0.39).
 */
export async function optionsOf(
	cfg: api.ClientConfig,
	cls: string,
	input: string
): Promise<string[]> {
	const info = (await api.objectInfo(cfg, cls)) as Record<
		string,
		{ input?: { required?: Record<string, [unknown, { options?: unknown }?]> } }
	>;
	const declared = info[cls]?.input?.required?.[input];
	const names = declared?.[0] === 'COMBO' ? declared[1]?.options : declared?.[0];
	return Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : [];
}

/** The server's diffusion models (`models/diffusion_models`), any family. */
export async function listDiffusionModels(cfg: api.ClientConfig): Promise<string[]> {
	return optionsOf(cfg, 'UNETLoader', 'unet_name');
}
