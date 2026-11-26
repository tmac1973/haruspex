/**
 * An upscaler entry's llama-toolchest server: the upscaler instances it lists
 * (`meta.kind` `upscale` or `vupscale`, with the route each needs), Settings'
 * Probe, and the check the upscale tools make before sending anything.
 */

import { errMessage } from '#lib/utils/error.ts';
import { instanceLabel, usable } from '#lib/toolchest/kind.ts';
import {
	parseGenerationModels,
	toolchestKeyFor,
	type ToolchestInstance
} from '#lib/toolchest/models.ts';
import {
	ToolchestError,
	hostOf,
	toolchestJson,
	type ToolchestConfig
} from '#lib/toolchest/client.ts';
import { saveUpscalerCaps, UPSCALERS_SECTION } from '#lib/upscale/entries.ts';
import type { UpscalerCaps, UpscalerEntry, UpscalerKind } from '#lib/upscale/types.ts';

const LISTED = { image: 'upscale', video: 'vupscale' } as const;
/** The route a build lists for an upscaler it can drive. */
const API: Record<UpscalerKind, string> = {
	image: 'images.upscale',
	video: 'video.upscale.jobs'
};
const NOUN: Record<UpscalerKind, string> = { image: 'picture', video: 'video' };

/** The server and key an entry names. */
export async function upscalerConfig(
	e: Pick<UpscalerEntry, 'url' | 'keyId'>
): Promise<ToolchestConfig> {
	return { baseUrl: e.url.trim(), apiKey: await toolchestKeyFor(e.keyId) };
}

/** The upscalers of `kind` on the server, from what `/v1/models` returned. */
export function upscalersIn(kind: UpscalerKind, json: unknown): ToolchestInstance[] {
	return parseGenerationModels(json, LISTED[kind]).filter((i) => i.api.includes(API[kind]));
}

/** The upscalers of `kind` the server has, running or not. */
export async function listUpscalers(
	kind: UpscalerKind,
	cfg: ToolchestConfig,
	signal?: AbortSignal
): Promise<ToolchestInstance[]> {
	return upscalersIn(kind, await toolchestJson(cfg, { path: '/v1/models' }, signal));
}

/** What a list entry keeps about an instance. */
export function upscalerCaps(kind: UpscalerKind, i: ToolchestInstance): UpscalerCaps {
	if (kind === 'video') return { scale: i.vupscale?.scale ?? i.scale ?? 2, limits: i.vupscale };
	return { scale: i.scale ?? 4, limits: null };
}

/** "×2 · up to 832×480, 33 frames": a list row's line. */
export function upscalerCapsLine(caps: UpscalerCaps): string {
	const l = caps.limits;
	if (!l?.measuredWidth || !l.measuredHeight) return `×${caps.scale}`;
	const frames = l.measuredFrames ? `, ${l.measuredFrames} frames` : '';
	return `×${caps.scale} · up to ${l.measuredWidth}×${l.measuredHeight}${frames}`;
}

/** Settings' Probe of one upscaler entry. */
export interface UpscalerProbe {
	ok: boolean;
	detail: string;
	/** The server's upscalers of this kind, for the dropdown; empty when it couldn't be read. */
	models: { name: string; label: string }[];
	caps?: UpscalerCaps;
}

/**
 * Probe entry `e`: the server answers, with the key, and has the chosen
 * upscaler. Saves what it learns about the upscaler on the entry.
 */
export async function probeUpscaler(kind: UpscalerKind, e: UpscalerEntry): Promise<UpscalerProbe> {
	const cfg = await upscalerConfig(e);
	if (!cfg.baseUrl) return { ok: false, detail: 'No server address.', models: [] };
	const host = hostOf(cfg.baseUrl);
	let all: ToolchestInstance[];
	try {
		all = await listUpscalers(kind, cfg);
	} catch (err) {
		if (err instanceof ToolchestError && err.status === 401) {
			return { ok: false, detail: 'Wrong or missing API key.', models: [] };
		}
		if (err instanceof ToolchestError && err.kind === 'unreachable') {
			return { ok: false, detail: `Can't reach ${host}.`, models: [] };
		}
		return { ok: false, detail: errMessage(err), models: [] };
	}
	const models = all.map((i) => ({ name: i.id, label: instanceLabel(i) }));
	if (all.length === 0) {
		return {
			ok: false,
			detail: `${host} has no ${NOUN[kind]} upscalers. Add one in llama-toolchest.`,
			models
		};
	}
	const id = e.model.trim();
	if (!id) return { ok: false, detail: 'Pick an upscaler.', models };
	const pick = all.find((i) => i.id === id);
	if (!pick) return { ok: false, detail: `${host} has no upscaler called ${id}.`, models };
	if (!usable(pick)) {
		return { ok: false, detail: `${id} is ${pick.state} — check it in llama-toolchest.`, models };
	}
	const caps = upscalerCaps(kind, pick);
	saveUpscalerCaps(kind, e.id, caps);
	const waking = pick.state === 'running' ? '' : ` (${pick.state}: it starts when used)`;
	return { ok: true, detail: `Connected — ${id} on ${host}${waking}.`, models, caps };
}

/**
 * Entry `e`'s upscaler, read fresh from its server and usable, with its
 * server and key; or a {@link ToolchestError} saying why not. Saves what it
 * learns, as a probe does.
 */
export async function readyUpscaler(
	kind: UpscalerKind,
	e: UpscalerEntry,
	signal?: AbortSignal
): Promise<{ cfg: ToolchestConfig; instance: ToolchestInstance; caps: UpscalerCaps }> {
	const cfg = await upscalerConfig(e);
	if (!cfg.baseUrl) {
		throw new ToolchestError(
			'unconfigured',
			`${e.name} has no server — ${UPSCALERS_SECTION[kind]}.`
		);
	}
	const id = e.model.trim();
	if (!id) {
		throw new ToolchestError(
			'unconfigured',
			`${e.name} has no upscaler picked — ${UPSCALERS_SECTION[kind]}.`
		);
	}
	const instance = (await listUpscalers(kind, cfg, signal)).find((i) => i.id === id);
	if (!instance) {
		throw new ToolchestError('unconfigured', `${id} is not on ${hostOf(cfg.baseUrl)} any more.`);
	}
	if (!usable(instance)) {
		throw new ToolchestError(
			'unconfigured',
			`${id} is ${instance.state} — check it in llama-toolchest.`
		);
	}
	const caps = upscalerCaps(kind, instance);
	saveUpscalerCaps(kind, e.id, caps);
	return { cfg, instance, caps };
}
