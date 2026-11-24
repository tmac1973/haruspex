/**
 * The video models the ComfyUI backend runs, by family: which file is which
 * (read from its name, as ComfyUI reports no architecture), what each can do
 * and make, its licence, the files it loads beside the model, and the core
 * nodes its graph uses.
 *
 * ComfyUI reports no video limits either, so each family's are fixed here:
 * the defaults its own workflow template uses, run on a 32 GB card.
 */
import * as api from '#lib/comfyui/client.ts';
import { optionsOf, pickCompanion } from '#lib/comfyui/nodes.ts';
import type { VideoCaps } from '#lib/videogen/types.ts';

export type VideoFamily = 'wan22_ti2v_5b' | 'wan22_i2v_14b' | 'wan22_s2v' | 'ltx23';

/** First match wins. Wan 2.2 I2V 14B is its high-noise file; the low-noise one is its companion. */
const FAMILY_PATTERNS: [VideoFamily, RegExp][] = [
	['wan22_ti2v_5b', /wan2[._]?2.*ti2v.*5b/i],
	['wan22_i2v_14b', /wan2[._]?2.*i2v.*high[_-]?noise.*14b/i],
	['wan22_s2v', /wan2[._]?2.*s2v/i],
	['ltx23', /ltx[-_]?2[._]?3.*\.safetensors$/i]
];

export function videoFamilyOf(model: string): VideoFamily | null {
	const name = model.replace(/^.*[\\/]/, '');
	return FAMILY_PATTERNS.find(([, re]) => re.test(name))?.[0] ?? null;
}

export const FAMILY_LABELS: Record<VideoFamily, string> = {
	wan22_ti2v_5b: 'Wan 2.2 TI2V 5B',
	wan22_i2v_14b: 'Wan 2.2 I2V 14B',
	wan22_s2v: 'Wan 2.2 S2V',
	ltx23: 'LTX-2.3'
};

const APACHE = { licence: 'Apache 2.0', commercialUse: true };

/** What each family can do and make. */
export const FAMILY_CAPS: Record<VideoFamily, VideoCaps> = {
	wan22_ti2v_5b: {
		text: true,
		startImage: true,
		endImage: false,
		speech: false,
		needsSpeech: false,
		sound: false,
		limits: {
			defaultSize: '1280x704',
			defaultFps: 24,
			fixedFps: 24,
			defaultFrames: 121,
			maxFrames: 121,
			maxSize: '1280x704',
			maxPixelFrames: null
		},
		frameStep: 4,
		...APACHE
	},
	wan22_i2v_14b: {
		text: false,
		startImage: true,
		endImage: true,
		speech: false,
		needsSpeech: false,
		sound: false,
		limits: {
			defaultSize: '832x480',
			defaultFps: 16,
			fixedFps: 16,
			defaultFrames: 81,
			maxFrames: 81,
			maxSize: '1280x720',
			maxPixelFrames: null
		},
		frameStep: 4,
		...APACHE
	},
	wan22_s2v: {
		text: false,
		startImage: true,
		endImage: false,
		speech: true,
		needsSpeech: true,
		sound: false,
		limits: {
			defaultSize: '832x480',
			defaultFps: 16,
			fixedFps: 16,
			defaultFrames: 77,
			maxFrames: 77,
			maxSize: '1280x720',
			maxPixelFrames: null
		},
		frameStep: 4,
		...APACHE
	},
	ltx23: {
		text: true,
		startImage: true,
		endImage: false,
		speech: false,
		needsSpeech: false,
		sound: true,
		limits: {
			defaultSize: '1280x704',
			defaultFps: 24,
			fixedFps: null,
			defaultFrames: 121,
			maxFrames: 241,
			maxSize: '1920x1088',
			maxPixelFrames: null
		},
		frameStep: 8,
		licence: 'LTX-2 Community License (commercial use only below its revenue threshold)',
		commercialUse: false
	}
};

/** A loader input that names a file, and what the file it should pick is called. */
interface Wanted {
	cls: string;
	input: string;
	patterns: RegExp[];
	/** What the user reads when it is missing. */
	label: string;
}

const UMT5: Wanted = {
	cls: 'CLIPLoader',
	input: 'clip_name',
	patterns: [/umt5[_-]?xxl.*fp8/i, /umt5[_-]?xxl/i],
	label: 'the umt5-xxl text encoder'
};
const WAN21_VAE: Wanted = {
	cls: 'VAELoader',
	input: 'vae_name',
	patterns: [/wan[_-]?2[._]?1[_-]?vae/i],
	label: 'the Wan 2.1 VAE'
};

/** The files each family loads beside its model, by role. */
export const WANTED: Record<VideoFamily, Record<string, Wanted>> = {
	wan22_ti2v_5b: {
		textEncoder: UMT5,
		vae: {
			cls: 'VAELoader',
			input: 'vae_name',
			patterns: [/wan[_-]?2[._]?2[_-]?vae/i],
			label: 'the Wan 2.2 VAE'
		}
	},
	wan22_i2v_14b: {
		textEncoder: UMT5,
		vae: WAN21_VAE,
		lowNoise: {
			cls: 'UNETLoader',
			input: 'unet_name',
			patterns: [/wan2[._]?2.*i2v.*low[_-]?noise.*14b/i],
			label: 'the Wan 2.2 I2V 14B low-noise model'
		},
		loraHigh: {
			cls: 'LoraLoaderModelOnly',
			input: 'lora_name',
			patterns: [/wan2[._]?2.*i2v.*lightx2v.*high[_-]?noise/i],
			label: 'the lightx2v 4-step high-noise LoRA'
		},
		loraLow: {
			cls: 'LoraLoaderModelOnly',
			input: 'lora_name',
			patterns: [/wan2[._]?2.*i2v.*lightx2v.*low[_-]?noise/i],
			label: 'the lightx2v 4-step low-noise LoRA'
		}
	},
	wan22_s2v: {
		textEncoder: UMT5,
		vae: WAN21_VAE,
		audioEncoder: {
			cls: 'AudioEncoderLoader',
			input: 'audio_encoder_name',
			patterns: [/wav2vec2[_-]?large/i],
			label: 'the wav2vec2 audio encoder'
		},
		lora: {
			cls: 'LoraLoaderModelOnly',
			input: 'lora_name',
			patterns: [/wan2[._]?2.*t2v.*lightx2v.*high[_-]?noise/i],
			label: 'the lightx2v 4-step LoRA'
		}
	},
	ltx23: {
		textEncoder: {
			cls: 'LTXAVTextEncoderLoader',
			input: 'text_encoder',
			patterns: [/gemma[_-]?3/i],
			label: 'the Gemma 3 text encoder'
		},
		lora: {
			cls: 'LoraLoaderModelOnly',
			input: 'lora_name',
			patterns: [/ltx[-_]?2[._]?3.*distilled/i],
			label: 'the LTX-2.3 distilled LoRA'
		},
		upscaler: {
			cls: 'LatentUpscaleModelLoader',
			input: 'model_name',
			patterns: [/ltx[-_]?2[._]?3.*spatial[-_]?upscaler/i],
			label: 'the LTX-2.3 spatial upscaler'
		}
	}
};

/** The core nodes each family's graph uses: one a server lacks is too old a ComfyUI. */
export const FAMILY_NODES: Record<VideoFamily, string[]> = {
	wan22_ti2v_5b: ['Wan22ImageToVideoLatent', 'CreateVideo', 'SaveVideo'],
	wan22_i2v_14b: ['WanImageToVideo', 'WanFirstLastFrameToVideo', 'KSamplerAdvanced', 'SaveVideo'],
	wan22_s2v: ['WanSoundImageToVideo', 'AudioEncoderLoader', 'LoadAudio', 'SaveVideo'],
	ltx23: ['LTXVImgToVideoInplace', 'LTXVAudioVAELoader', 'LTXVConcatAVLatent', 'SaveVideo']
};

/** Which loader lists a family's own model file. */
export function modelLoader(family: VideoFamily): { cls: string; input: string } {
	return family === 'ltx23'
		? { cls: 'CheckpointLoaderSimple', input: 'ckpt_name' }
		: { cls: 'UNETLoader', input: 'unet_name' };
}

/** The video models on the server that a family here runs. */
export async function listVideoModels(
	cfg: api.ClientConfig
): Promise<{ name: string; family: VideoFamily }[]> {
	const [unets, checkpoints] = await Promise.all([
		optionsOf(cfg, 'UNETLoader', 'unet_name').catch((): string[] => []),
		optionsOf(cfg, 'CheckpointLoaderSimple', 'ckpt_name').catch((): string[] => [])
	]);
	return [...unets, ...checkpoints].flatMap((name) => {
		const family = videoFamilyOf(name);
		return family &&
			modelLoader(family).cls === (unets.includes(name) ? 'UNETLoader' : 'CheckpointLoaderSimple')
			? [{ name, family }]
			: [];
	});
}

/**
 * The files `family` loads beside its model, by role, from what the server
 * has; and the labels of those it lacks.
 */
export async function resolveCompanions(
	cfg: api.ClientConfig,
	family: VideoFamily
): Promise<{ found: Record<string, string>; missing: string[] }> {
	const found: Record<string, string> = {};
	const missing: string[] = [];
	const lists = new Map<string, Promise<string[]>>();
	for (const [role, w] of Object.entries(WANTED[family])) {
		const key = `${w.cls}.${w.input}`;
		if (!lists.has(key)) lists.set(key, optionsOf(cfg, w.cls, w.input));
		const hit = pickCompanion(await lists.get(key)!, w.patterns);
		if (hit) found[role] = hit;
		else missing.push(w.label);
	}
	return { found, missing };
}

/** The core nodes `family` needs that the server lacks. */
export async function missingNodes(cfg: api.ClientConfig, family: VideoFamily): Promise<string[]> {
	const answers = await Promise.all(
		FAMILY_NODES[family].map(async (cls) => {
			const info = (await api.objectInfo(cfg, cls).catch(() => null)) as Record<
				string,
				unknown
			> | null;
			return info && cls in info ? null : cls;
		})
	);
	return answers.filter((c): c is string => c !== null);
}
