/**
 * The workflow each video family runs, as ComfyUI's API graph: built from the
 * workflow templates ComfyUI 0.39 ships (`video_wan2_2_5B_ti2v`,
 * `video_wan2_2_14B_i2v`, `video_wan2_2_14B_flf2v`, `video_wan2_2_14B_s2v`,
 * `video_ltx2_3_t2v` / `_i2v`), with their settings: the 14B and S2V ones
 * with the lightx2v 4-step LoRAs on, and one S2V chunk (no extend chain).
 *
 * Every graph ends in `SaveVideo` as WebM (AV1), whose node is
 * {@link OUTPUT_NODE}.
 */
import type { ComfyGraph } from '#lib/comfyui/fieldMap.ts';
import type { VideoFamily } from '#lib/videogen/comfyui/families.ts';

export const OUTPUT_NODE = 'save';

/** Wan's own negative prompt, from its templates. */
const WAN_NEGATIVE =
	'色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走';

/** What a graph is built from: the request, and the files on the server it loads. */
export interface GraphInput {
	model: string;
	companions: Record<string, string>;
	prompt: string;
	negativePrompt?: string;
	width: number;
	height: number;
	frames: number;
	fps: number;
	seed: number;
	/** Names in the server's input folder, once uploaded. */
	startImage?: string;
	endImage?: string;
	audio?: string;
	/** Where the clip is saved on the server: `haruspex/<client id>`. */
	prefix: string;
}

type Ref = [string, number];
const node = (class_type: string, inputs: Record<string, unknown>) => ({ class_type, inputs });

function save(video: Ref, prefix: string) {
	return node('SaveVideo', { video, filename_prefix: prefix, format: 'webm', codec: 'auto' });
}

function wanText(g: ComfyGraph, x: GraphInput): { positive: Ref; negative: Ref } {
	g.clip = node('CLIPLoader', {
		clip_name: x.companions.textEncoder,
		type: 'wan',
		device: 'default'
	});
	g.positive = node('CLIPTextEncode', { text: x.prompt, clip: ['clip', 0] });
	g.negative = node('CLIPTextEncode', {
		text: x.negativePrompt?.trim() || WAN_NEGATIVE,
		clip: ['clip', 0]
	});
	return { positive: ['positive', 0], negative: ['negative', 0] };
}

/** Wan 2.2 TI2V 5B: a prompt, or a start picture, at 24 fps. */
function wan5b(x: GraphInput): ComfyGraph {
	const g: ComfyGraph = {};
	g.unet = node('UNETLoader', { unet_name: x.model, weight_dtype: 'default' });
	g.vae = node('VAELoader', { vae_name: x.companions.vae });
	g.shift = node('ModelSamplingSD3', { model: ['unet', 0], shift: 8 });
	const { positive, negative } = wanText(g, x);
	g.latent = node('Wan22ImageToVideoLatent', {
		vae: ['vae', 0],
		width: x.width,
		height: x.height,
		length: x.frames,
		batch_size: 1
	});
	if (x.startImage) {
		g.start = node('LoadImage', { image: x.startImage });
		g.latent.inputs.start_image = ['start', 0];
	}
	g.sampler = node('KSampler', {
		seed: x.seed,
		steps: 20,
		cfg: 5,
		sampler_name: 'uni_pc',
		scheduler: 'simple',
		denoise: 1,
		model: ['shift', 0],
		positive,
		negative,
		latent_image: ['latent', 0]
	});
	g.decode = node('VAEDecode', { samples: ['sampler', 0], vae: ['vae', 0] });
	g.video = node('CreateVideo', { images: ['decode', 0], fps: x.fps });
	g[OUTPUT_NODE] = save(['video', 0], x.prefix);
	return g;
}

/**
 * Wan 2.2 I2V 14B with the lightx2v 4-step LoRAs: two passes, the high-noise
 * model for the first two steps and the low-noise one for the last two. With
 * an end picture, first-last-frame conditioning.
 */
function wan14b(x: GraphInput): ComfyGraph {
	const g: ComfyGraph = {};
	g.high = node('UNETLoader', { unet_name: x.model, weight_dtype: 'default' });
	g.low = node('UNETLoader', { unet_name: x.companions.lowNoise, weight_dtype: 'default' });
	g.loraHigh = node('LoraLoaderModelOnly', {
		model: ['high', 0],
		lora_name: x.companions.loraHigh,
		strength_model: 1
	});
	g.loraLow = node('LoraLoaderModelOnly', {
		model: ['low', 0],
		lora_name: x.companions.loraLow,
		strength_model: 1
	});
	g.shiftHigh = node('ModelSamplingSD3', { model: ['loraHigh', 0], shift: 5 });
	g.shiftLow = node('ModelSamplingSD3', { model: ['loraLow', 0], shift: 5 });
	g.vae = node('VAELoader', { vae_name: x.companions.vae });
	const { positive, negative } = wanText(g, x);
	const size = { width: x.width, height: x.height, length: x.frames, batch_size: 1 };
	if (x.startImage) g.start = node('LoadImage', { image: x.startImage });
	if (x.endImage) {
		g.end = node('LoadImage', { image: x.endImage });
		g.cond = node('WanFirstLastFrameToVideo', {
			positive,
			negative,
			vae: ['vae', 0],
			...size,
			...(x.startImage ? { start_image: ['start', 0] } : {}),
			end_image: ['end', 0]
		});
	} else {
		g.cond = node('WanImageToVideo', {
			positive,
			negative,
			vae: ['vae', 0],
			...size,
			...(x.startImage ? { start_image: ['start', 0] } : {})
		});
	}
	const pass = (model: string, first: boolean) =>
		node('KSamplerAdvanced', {
			model: [model, 0],
			add_noise: first ? 'enable' : 'disable',
			noise_seed: first ? x.seed : 0,
			steps: 4,
			cfg: 1,
			sampler_name: 'euler',
			scheduler: 'simple',
			positive: ['cond', 0],
			negative: ['cond', 1],
			latent_image: first ? ['cond', 2] : ['highPass', 0],
			start_at_step: first ? 0 : 2,
			end_at_step: first ? 2 : 10000,
			return_with_leftover_noise: first ? 'enable' : 'disable'
		});
	g.highPass = pass('shiftHigh', true);
	g.lowPass = pass('shiftLow', false);
	g.decode = node('VAEDecode', { samples: ['lowPass', 0], vae: ['vae', 0] });
	g.video = node('CreateVideo', { images: ['decode', 0], fps: x.fps });
	g[OUTPUT_NODE] = save(['video', 0], x.prefix);
	return g;
}

/**
 * Wan 2.2 S2V with the lightx2v 4-step LoRA: the person in the start picture
 * says the speech, in one chunk of up to 77 frames. As in the template, the
 * first latent frame is doubled before decoding and the first three pictures
 * dropped after.
 */
function wanS2v(x: GraphInput): ComfyGraph {
	const g: ComfyGraph = {};
	g.unet = node('UNETLoader', { unet_name: x.model, weight_dtype: 'default' });
	g.lora = node('LoraLoaderModelOnly', {
		model: ['unet', 0],
		lora_name: x.companions.lora,
		strength_model: 1
	});
	g.shift = node('ModelSamplingSD3', { model: ['lora', 0], shift: 8 });
	g.vae = node('VAELoader', { vae_name: x.companions.vae });
	const { positive, negative } = wanText(g, x);
	g.audioEncoder = node('AudioEncoderLoader', { audio_encoder_name: x.companions.audioEncoder });
	g.audio = node('LoadAudio', { audio: x.audio ?? '' });
	g.encoded = node('AudioEncoderEncode', {
		audio_encoder: ['audioEncoder', 0],
		audio: ['audio', 0]
	});
	g.person = node('LoadImage', { image: x.startImage ?? '' });
	g.cond = node('WanSoundImageToVideo', {
		positive,
		negative,
		vae: ['vae', 0],
		width: x.width,
		height: x.height,
		length: x.frames,
		batch_size: 1,
		audio_encoder_output: ['encoded', 0],
		ref_image: ['person', 0]
	});
	g.sampler = node('KSampler', {
		seed: x.seed,
		steps: 4,
		cfg: 1,
		sampler_name: 'uni_pc',
		scheduler: 'simple',
		denoise: 1,
		model: ['shift', 0],
		positive: ['cond', 0],
		negative: ['cond', 1],
		latent_image: ['cond', 2]
	});
	g.first = node('LatentCut', { samples: ['sampler', 0], dim: 't', index: 0, amount: 1 });
	g.joined = node('LatentConcat', { samples1: ['first', 0], samples2: ['sampler', 0], dim: 't' });
	g.decode = node('VAEDecode', { samples: ['joined', 0], vae: ['vae', 0] });
	g.frames = node('ImageFromBatch', { image: ['decode', 0], batch_index: 3, length: 4096 });
	g.video = node('CreateVideo', { images: ['frames', 0], fps: x.fps, audio: ['audio', 0] });
	g[OUTPUT_NODE] = save(['video', 0], x.prefix);
	return g;
}

/** LTX-2.3's own negative prompt, from its templates. */
const LTX_NEGATIVE = 'pc game, console game, video game, cartoon, childish, ugly';

/** The video latent with the start picture put in, at `strength`, when there is one. */
function ltxWithPicture(
	g: ComfyGraph,
	id: string,
	latent: Ref,
	strength: number,
	x: GraphInput
): Ref {
	if (!x.startImage) return latent;
	g[id] = node('LTXVImgToVideoInplace', {
		vae: ['ckpt', 2],
		image: ['picture', 0],
		latent,
		strength,
		bypass: false
	});
	return [id, 0];
}

/**
 * LTX-2.3 with its distilled LoRA, video and sound together: sampled at half
 * size, then the video latent upscaled ×2 and refined in a short second pass,
 * as the template does. A start picture conditions both passes.
 */
function ltx23(x: GraphInput): ComfyGraph {
	const g: ComfyGraph = {};
	ltxInputs(g, x);
	ltxFirstPass(g, x);
	ltxSecondPass(g, x);
	return g;
}

/** The checkpoint, LoRA, text, conditioning and start picture both passes use. */
function ltxInputs(g: ComfyGraph, x: GraphInput): void {
	g.ckpt = node('CheckpointLoaderSimple', { ckpt_name: x.model });
	g.lora = node('LoraLoaderModelOnly', {
		model: ['ckpt', 0],
		lora_name: x.companions.lora,
		strength_model: 0.5
	});
	g.audioVae = node('LTXVAudioVAELoader', { ckpt_name: x.model });
	g.text = node('LTXAVTextEncoderLoader', {
		text_encoder: x.companions.textEncoder,
		ckpt_name: x.model,
		device: 'default'
	});
	g.positive = node('CLIPTextEncode', { text: x.prompt, clip: ['text', 0] });
	g.negative = node('CLIPTextEncode', {
		text: x.negativePrompt?.trim() || LTX_NEGATIVE,
		clip: ['text', 0]
	});
	g.cond = node('LTXVConditioning', {
		positive: ['positive', 0],
		negative: ['negative', 0],
		frame_rate: x.fps
	});
	if (x.startImage) {
		g.load = node('LoadImage', { image: x.startImage });
		g.scaled = node('ImageScale', {
			image: ['load', 0],
			upscale_method: 'lanczos',
			width: x.width,
			height: x.height,
			crop: 'center'
		});
		g.picture = node('LTXVPreprocess', { image: ['scaled', 0], img_compression: 18 });
	}
}

/** Video and sound sampled together at half size. */
function ltxFirstPass(g: ComfyGraph, x: GraphInput): void {
	g.empty = node('EmptyLTXVLatentVideo', {
		width: Math.round(x.width / 2),
		height: Math.round(x.height / 2),
		length: x.frames,
		batch_size: 1
	});
	g.silence = node('LTXVEmptyLatentAudio', {
		frames_number: x.frames,
		frame_rate: x.fps,
		batch_size: 1,
		audio_vae: ['audioVae', 0]
	});
	g.firstAv = node('LTXVConcatAVLatent', {
		video_latent: ltxWithPicture(g, 'firstPicture', ['empty', 0], 0.7, x),
		audio_latent: ['silence', 0]
	});
	g.sampler = node('KSamplerSelect', { sampler_name: 'euler' });
	g.firstGuider = node('CFGGuider', {
		model: ['lora', 0],
		positive: ['cond', 0],
		negative: ['cond', 1],
		cfg: 1
	});
	g.firstNoise = node('RandomNoise', { noise_seed: x.seed });
	g.firstSigmas = node('ManualSigmas', {
		sigmas: '1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0'
	});
	g.firstPass = node('SamplerCustomAdvanced', {
		noise: ['firstNoise', 0],
		guider: ['firstGuider', 0],
		sampler: ['sampler', 0],
		sigmas: ['firstSigmas', 0],
		latent_image: ['firstAv', 0]
	});
	g.firstSplit = node('LTXVSeparateAVLatent', { av_latent: ['firstPass', 0] });
}

/** The video latent upscaled ×2 and refined, then decoded with its sound and saved. */
function ltxSecondPass(g: ComfyGraph, x: GraphInput): void {
	g.upscaler = node('LatentUpscaleModelLoader', { model_name: x.companions.upscaler });
	g.upscaled = node('LTXVLatentUpsampler', {
		samples: ['firstSplit', 0],
		upscale_model: ['upscaler', 0],
		vae: ['ckpt', 2]
	});
	g.secondAv = node('LTXVConcatAVLatent', {
		video_latent: ltxWithPicture(g, 'secondPicture', ['upscaled', 0], 1, x),
		audio_latent: ['firstSplit', 1]
	});
	g.crop = node('LTXVCropGuides', {
		positive: ['cond', 0],
		negative: ['cond', 1],
		latent: ['firstSplit', 0]
	});
	g.secondGuider = node('CFGGuider', {
		model: ['lora', 0],
		positive: ['crop', 0],
		negative: ['crop', 1],
		cfg: 1
	});
	g.secondNoise = node('RandomNoise', { noise_seed: 42 });
	g.secondSigmas = node('ManualSigmas', { sigmas: '0.85, 0.7250, 0.4219, 0.0' });
	g.secondPass = node('SamplerCustomAdvanced', {
		noise: ['secondNoise', 0],
		guider: ['secondGuider', 0],
		sampler: ['sampler', 0],
		sigmas: ['secondSigmas', 0],
		latent_image: ['secondAv', 0]
	});
	g.secondSplit = node('LTXVSeparateAVLatent', { av_latent: ['secondPass', 0] });
	g.decode = node('VAEDecodeTiled', {
		samples: ['secondSplit', 0],
		vae: ['ckpt', 2],
		tile_size: 768,
		overlap: 64,
		temporal_size: 4096,
		temporal_overlap: 4
	});
	g.sound = node('LTXVAudioVAEDecode', { samples: ['secondSplit', 1], audio_vae: ['audioVae', 0] });
	g.video = node('CreateVideo', { images: ['decode', 0], audio: ['sound', 0], fps: x.fps });
	g[OUTPUT_NODE] = save(['video', 0], x.prefix);
}

const BUILDERS: Record<VideoFamily, (x: GraphInput) => ComfyGraph> = {
	wan22_ti2v_5b: wan5b,
	wan22_i2v_14b: wan14b,
	wan22_s2v: wanS2v,
	ltx23
};

/** The graph for `family`. */
export function buildVideoGraph(family: VideoFamily, x: GraphInput): ComfyGraph {
	return BUILDERS[family](x);
}
