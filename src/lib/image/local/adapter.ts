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
 * three that carries every parameter the job needs (negative prompt, seed,
 * sampler, denoising strength and an init image) in a shape that is stable
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

/**
 * What the backend declares it can do.
 *
 * Read from the fixture, never asserted here. A capability claim nobody
 * checks is how the asset job stops degrading and starts silently shipping
 * off-style art — so when a version bump drops a feature, the committed
 * fixture changes and a test fails, rather than the claim quietly outliving
 * the build that justified it.
 *
 * Reference conditioning additionally requires an img2img route: the flag
 * says IP-Adapter was compiled in, and the route is how a reference image
 * would actually reach it. Either one missing means the layer is unavailable,
 * and phase 09's generation loop degrades per entry around it.
 */
export function declaredCapabilities(): ImageBackendCapabilities {
	return capabilitiesFrom(FIXTURE);
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
	const hasImg2Img = fixture.routes.includes(ROUTES.img2img);
	return {
		referenceConditioning: c.referenceConditioning && hasImg2Img,
		seamlessTiling: c.seamlessTiling,
		loras: c.loras,
		maxLoras: c.loras ? c.maxLoras : 0
	};
}

export interface A1111Request {
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
	init_images?: string[];
	denoising_strength?: number;
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

/** Sampler names differ per build; this is the pinned build's default. */
export const DEFAULT_SAMPLER = { name: 'euler_a', steps: 28, cfg: 7 } as const;

/**
 * Where the reference image goes when there is one.
 *
 * img2img with a low denoising strength is NOT the same operation as
 * IP-Adapter style transfer, and this is the honest mapping of what the build
 * offers: it starts from the reference rather than from noise, so the subject
 * of the reference bleeds into the result. That is exactly the failure the
 * ComfyUI path abandoned img2img for. Until this backend can do real
 * reference conditioning the capability is reported false, which is why
 * `declaredCapabilities` gates it on the route and why the job degrades.
 */
export function buildRequest(
	req: {
		prompt: string;
		negativePrompt?: string;
		seed: number | null;
		width: number;
		height: number;
		sampler?: { name: string; steps: number; cfg: number };
		referenceImage?: Uint8Array;
		referenceStrength?: number;
	},
	caps: ImageBackendCapabilities
): { route: string; body: A1111Request } {
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

	if (caps.referenceConditioning && req.referenceImage && req.referenceImage.length > 0) {
		return {
			route: ROUTES.img2img,
			body: {
				...body,
				init_images: [toBase64(req.referenceImage)],
				// The API's strength is how far to travel FROM the reference,
				// so a caller asking to be pulled hard toward it wants a low
				// number here. Inverting it in one place keeps every caller on
				// one meaning of "reference strength".
				denoising_strength: 1 - (req.referenceStrength ?? 0.6)
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
