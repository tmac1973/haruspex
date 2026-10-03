/**
 * What the pinned sd-server build actually serves, and how to talk to it.
 *
 * Separate from the backend for the same reason the ComfyUI field map is
 * separate from its client: the routes and their payload shapes belong to the
 * BUILD, and the build is pinned and replaceable. When the pin moves, the
 * fixture `scripts/sdcpp-capabilities.sh` emits changes, and the only code
 * that should have to follow is here.
 *
 * The pinned build serves three HTTP APIs at once — its own `/sdcpp/v1/*`, an
 * AUTOMATIC1111-compatible `/sdapi/v1/*`, and an OpenAI-compatible
 * `/v1/images/*`. This adapter uses the A1111 one: it is the only one of the
 * three that carries every parameter the job needs (negative prompt, seed and
 * sampler) in a shape that is stable
 * across the wider ecosystem rather than specific to one project's release.
 */

import capabilities from './capabilities.json';
import type { ImageBackendCapabilities } from '../types';

/** The committed fixture, as emitted for the pinned build. */
export interface SdCapabilityFixture {
	version: string;
	capabilities: ImageBackendCapabilities;
	flags: Record<string, string>;
	routes: string[];
}

export const FIXTURE = capabilities as unknown as SdCapabilityFixture;

export const ROUTES = {
	/** Answers only once the weights are loaded, so it doubles as readiness. */
	ready: '/sdcpp/v1/capabilities',
	txt2img: '/sdapi/v1/txt2img',
	img2img: '/sdapi/v1/img2img',
	models: '/sdapi/v1/sd-models'
} as const;

/** Does the pinned build serve this route at all? */
export function serves(route: string): boolean {
	return FIXTURE.routes.includes(route);
}

/** The families this engine runs; a catalogue id is its family. */
export type LocalFamily = 'ming' | 'qwen21';

export function familyOfId(id: string): LocalFamily | null {
	return id === 'ming' || id === 'qwen21' ? id : null;
}

/**
 * What the backend declares it can do, for the model it would run.
 *
 * The build's compiled-in features come from the fixture, never asserted
 * here: when a version bump drops one, the committed fixture changes and a
 * test fails. What a model can do on top of that is this engine's to say —
 * and both families draw transparent images (Ming from a clear start, Qwen by
 * prompt), neither tiles here (`--circular` is a UNet trick; the DiT remedy,
 * offset-and-inpaint, is ComfyUI-only for now), and neither takes our LoRAs.
 */
export function declaredCapabilities(family: LocalFamily | null = null): ImageBackendCapabilities {
	const build = capabilitiesFrom(FIXTURE);
	if (!family) return build;
	return { transparency: true, seamlessTiling: false, loras: false, maxLoras: 0 };
}

/**
 * The same rule, as a function of a fixture.
 *
 * Split out so it can be tested against fixtures OTHER than the one currently
 * committed. Testing only the committed fixture is vacuous whenever that
 * fixture has everything switched on — a hardcoded `true` passes identically,
 * which is exactly the bug the fixture exists to prevent.
 */
export function capabilitiesFrom(fixture: SdCapabilityFixture): ImageBackendCapabilities {
	const c = fixture.capabilities;
	return {
		transparency: c.transparency,
		seamlessTiling: c.seamlessTiling,
		loras: c.loras,
		maxLoras: c.loras ? c.maxLoras : 0
	};
}

export interface A1111Request {
	/** img2img only: the start image, base64 PNG. */
	init_images?: string[];
	/** img2img only: how far from the start image to go, 0..1. */
	denoising_strength?: number;
	prompt: string;
	negative_prompt: string;
	seed: number;
	width: number;
	height: number;
	steps: number;
	cfg_scale: number;
	sampler_name: string;
	batch_size: 1;
	n_iter: 1;
}

/** Base64 of a PNG, without a data: prefix — what `init_images` expects. */
export function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}

export function fromBase64(b64: string): Uint8Array {
	// Tolerate a data: URL: some builds return one and the difference is not
	// worth a failed generation.
	const raw = b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64;
	const bin = atob(raw);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** Each family's sampler, as measured (`measurements-phase-24-gguf.md`). */
export const FAMILY_SAMPLER: Record<LocalFamily, { name: string; steps: number; cfg: number }> = {
	ming: { name: 'euler', steps: 12, cfg: 1 },
	qwen21: { name: 'euler', steps: 25, cfg: 1 }
};

/** For a request with no family to go by. */
export const DEFAULT_SAMPLER = FAMILY_SAMPLER.ming;

/**
 * Ming gives alpha only from the latent of a transparent canvas, at this
 * strength, with its RGBA phrase: 0.95 and 1.0 stay opaque, lower draws the
 * subject smaller (phase 17).
 */
export const CLEAR_START_STRENGTH = 0.9;

/**
 * The request body for one generation.
 *
 * txt2img, unless `clearStart` carries a transparent canvas: then img2img
 * from it, which is how Ming-Image makes alpha here as in ComfyUI.
 */
export function buildRequest(req: {
	prompt: string;
	negativePrompt?: string;
	seed: number | null;
	width: number;
	height: number;
	sampler?: { name: string; steps: number; cfg: number };
	/** A transparent PNG of the request's size, base64. */
	clearStart?: string;
}): { route: string; body: A1111Request } {
	const sampler = req.sampler ?? DEFAULT_SAMPLER;
	const body: A1111Request = {
		prompt: req.prompt,
		negative_prompt: req.negativePrompt ?? '',
		// -1 is this API's "pick one". Passing 0 would silently make every
		// request that did not pin a seed produce the identical image.
		seed: req.seed ?? -1,
		width: req.width,
		height: req.height,
		steps: sampler.steps,
		cfg_scale: sampler.cfg,
		sampler_name: sampler.name,
		batch_size: 1,
		n_iter: 1
	};
	if (req.clearStart) {
		return {
			route: ROUTES.img2img,
			body: {
				...body,
				init_images: [req.clearStart],
				denoising_strength: CLEAR_START_STRENGTH
			}
		};
	}
	return { route: ROUTES.txt2img, body };
}

/** The images in an A1111 response, in order. */
export function imagesFrom(payload: unknown): Uint8Array[] {
	const images = (payload as { images?: unknown })?.images;
	if (!Array.isArray(images)) return [];
	return images.filter((i): i is string => typeof i === 'string').map(fromBase64);
}

/**
 * The seed the server actually used.
 *
 * A1111 returns it inside `info`, which is a JSON STRING rather than an
 * object. Parsed defensively: a recipe recording a seed nobody used explains
 * nothing, and neither does one that throws.
 */
export function seedFrom(payload: unknown, fallback: number): number {
	const info = (payload as { info?: unknown })?.info;
	if (typeof info === 'string') {
		try {
			const parsed = JSON.parse(info) as { seed?: unknown; all_seeds?: unknown[] };
			if (typeof parsed.seed === 'number') return parsed.seed;
			const first = Array.isArray(parsed.all_seeds) ? parsed.all_seeds[0] : undefined;
			if (typeof first === 'number') return first;
		} catch {
			// Not JSON. Fall through.
		}
	}
	return fallback;
}
