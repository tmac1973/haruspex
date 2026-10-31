/**
 * What the image, music and video backends do the same way on a
 * llama-toolchest server: read their section's address, key and chosen
 * instance from settings, list the server's instances of their kind, check
 * the chosen one is running, answer Settings' Probe, and settle a job once
 * `followJob` has it ended. Each kind differs only in its settings fields and
 * the words it uses; what it sends and reads stays in its own backend.
 *
 * Errors are {@link ToolchestError}s, which each backend turns into its own
 * error type as it does for the client's.
 */

import { invoke } from '@tauri-apps/api/core';
import { getSettings, updateSettings } from '#lib/stores/settings.ts';
import type { ModelOption, ProbeResult } from '#lib/image/backend.ts';
import type { StoredAudio } from '#lib/ipc/gen/StoredAudio.ts';
import { errMessage } from '#lib/utils/error.ts';
import { inferenceToolchest, type FoundToolchest } from '#lib/toolchest/detect.ts';
import {
	parseGenerationModels,
	toolchestKeyFor,
	type ApiKeyIdField,
	type GenerationKind,
	type ToolchestInstance
} from '#lib/toolchest/models.ts';
import {
	ToolchestError,
	hostOf,
	toolchestJson,
	type ToolchestConfig
} from '#lib/toolchest/client.ts';
import type { JobLike } from '#lib/toolchest/jobs.ts';

/** Each kind's settings fields, its noun, and the section that sets it. */
const KINDS = {
	image: {
		url: 'imageToolchestBaseUrl',
		key: 'imageToolchestApiKeyId',
		model: 'imageToolchestModelId',
		section: 'Settings → Image'
	},
	music: {
		url: 'musicToolchestBaseUrl',
		key: 'musicToolchestApiKeyId',
		model: 'musicToolchestModelId',
		section: 'Settings → Music'
	},
	video: {
		url: 'videoGenToolchestBaseUrl',
		key: 'videoGenToolchestApiKeyId',
		model: 'videoGenToolchestModelId',
		section: 'Settings → Video generation'
	}
} as const satisfies Record<
	GenerationKind,
	{ url: string; key: ApiKeyIdField; model: string; section: string }
>;

/** The `/v1/models` route every toolchest build serves. */
const MODELS_ROUTE = '/v1/models';

/**
 * States an instance can make nothing in. Any other, `stopped` included, is
 * worth calling: toolchest starts an enabled instance when a request names it.
 */
const UNUSABLE = new Set(['failed', 'error', 'disabled']);

/** Whether a request may name this instance. */
export function usable(i: ToolchestInstance): boolean {
	return !UNUSABLE.has(i.state);
}

/** A model's line in a dropdown. */
export function instanceLabel(i: ToolchestInstance): string {
	return i.state === 'running' ? i.id : `${i.id} — ${i.state}`;
}

/** The dropdown's options: the server's, plus the saved one if it is not among them. */
export function withSavedModel(current: string, models: ModelOption[]): ModelOption[] {
	const id = current.trim();
	if (!id || models.some((m) => m.name === id)) return models;
	const why = models.length > 0 ? 'not on the server' : 'probe to check';
	return [{ name: id, label: `${id} — ${why}` }, ...models];
}

/**
 * A section switched to llama-toolchest with no address yet starts from the
 * inference server, when that is a toolchest: usually the same machine and
 * key. Returns what it filled in, or null when it left the section alone.
 */
export function prefillFromInference(kind: GenerationKind): FoundToolchest | null {
	const k = KINDS[kind];
	const found = inferenceToolchest();
	if (!found || getSettings()[k.url].trim()) return null;
	updateSettings({ [k.url]: found.baseUrl, [k.key]: found.apiKeyId });
	return found;
}

/**
 * A finished job's ended state, or why there is nothing to keep. Called with
 * what `followJob` returned.
 */
export function settleJob<J extends JobLike & { error: string | null }>(job: J): J {
	if (job.status === 'cancelled') throw new ToolchestError('cancelled', 'Cancelled.');
	if (job.status === 'failed') {
		throw new ToolchestError('rejected', `llama-toolchest: ${job.error ?? 'the job failed'}`);
	}
	return job;
}

/**
 * Download a finished job's file straight into the audio cache, which keeps
 * songs and clips alike: toolchest deletes them after a day.
 */
export function storeJobFile(
	cfg: ToolchestConfig,
	path: string,
	mimeHint: string,
	keep: { title?: string; conversationId?: string; codeSessionId?: string }
): Promise<StoredAudio> {
	return invoke<StoredAudio>('audio_store_url', {
		url: `${cfg.baseUrl.replace(/\/+$/, '')}${path}`,
		apiKey: cfg.apiKey || null,
		mimeHint,
		title: keep.title || null,
		conversationId: keep.conversationId ?? null,
		codeSessionId: keep.codeSessionId ?? null
	});
}

/** One kind's view of its toolchest server; see the top of this file. */
export function toolchestKind(kind: GenerationKind) {
	const k = KINDS[kind];
	/** What a probe or a generation last saw, for the sync questions asked after. */
	let lastInstances: ToolchestInstance[] = [];
	/** The server's upscalers, from the same read; kept for the image kind only. */
	let lastUpscalers: ToolchestInstance[] = [];

	/** The section's server and key. */
	async function config(): Promise<ToolchestConfig> {
		const s = getSettings();
		return { baseUrl: s[k.url].trim(), apiKey: await toolchestKeyFor(s[k.key]) };
	}

	/** The section's server and key as a job handle names them, whatever it says now. */
	async function configFor(baseUrl: string, keyId: string | null | undefined) {
		return { baseUrl, apiKey: await toolchestKeyFor(keyId || null) };
	}

	/** The id of the section's named key, for a job handle. */
	function keyId(): string {
		return getSettings()[k.key] ?? '';
	}

	function chosenId(): string {
		return (getSettings()[k.model] ?? '').trim();
	}

	/** The server's instances of this kind, remembered for {@link seen}. */
	async function instances(
		cfg: ToolchestConfig,
		signal?: AbortSignal
	): Promise<ToolchestInstance[]> {
		const json = await toolchestJson(cfg, { path: MODELS_ROUTE }, signal);
		lastInstances = parseGenerationModels(json, kind);
		if (kind === 'image') lastUpscalers = parseGenerationModels(json, 'upscale');
		return lastInstances;
	}

	/**
	 * The upscalers the last read saw that a request may name. Toolchest runs
	 * one as a set of its own, beside the image instances.
	 */
	function upscalers(): ToolchestInstance[] {
		return lastUpscalers.filter((i) => usable(i) && i.api.includes('images.upscale'));
	}

	/** Every instance the last probe or generation saw. */
	function seen(): ToolchestInstance[] {
		return lastInstances;
	}

	/** The chosen instance as last seen, without asking the server. */
	function chosen(): ToolchestInstance | undefined {
		const id = chosenId();
		return lastInstances.find((i) => i.id === id);
	}

	/** The chosen instance, running, or why it can't make anything now. */
	async function readyInstance(
		cfg: ToolchestConfig,
		signal?: AbortSignal
	): Promise<ToolchestInstance> {
		if (!cfg.baseUrl) {
			throw new ToolchestError('unconfigured', `No llama-toolchest server is set — ${k.section}.`);
		}
		const id = chosenId();
		if (!id) throw new ToolchestError('unconfigured', `No ${kind} model is chosen — ${k.section}.`);
		const instance = (await instances(cfg, signal)).find((i) => i.id === id);
		if (!instance) {
			throw new ToolchestError(
				'unconfigured',
				`${id} is not on ${hostOf(cfg.baseUrl)} any more — ${k.section}.`
			);
		}
		if (!usable(instance)) {
			throw new ToolchestError(
				'unconfigured',
				`${id} is ${instance.state} — check it in llama-toolchest.`
			);
		}
		return instance;
	}

	/**
	 * Settings' Probe: reachable, with the key, and the chosen instance
	 * running. `how` adds a word on how the chosen one will be driven.
	 */
	async function probe(how?: (chosen: ToolchestInstance) => string): Promise<ProbeResult> {
		return probeServer(kind, await config(), instances, chosenId(), how);
	}

	return {
		config,
		configFor,
		keyId,
		chosenId,
		instances,
		seen,
		chosen,
		upscalers,
		readyInstance,
		probe
	};
}

async function probeServer(
	kind: GenerationKind,
	cfg: ToolchestConfig,
	instances: (cfg: ToolchestConfig) => Promise<ToolchestInstance[]>,
	chosenId: string,
	how?: (chosen: ToolchestInstance) => string
): Promise<ProbeResult> {
	const section = KINDS[kind].section;
	if (!cfg.baseUrl) return { ok: false, detail: `No server address — ${section}.` };
	const host = hostOf(cfg.baseUrl);
	let all: ToolchestInstance[];
	try {
		all = await instances(cfg);
	} catch (e) {
		if (e instanceof ToolchestError && e.status === 401) {
			return { ok: false, detail: 'Wrong or missing API key.' };
		}
		if (e instanceof ToolchestError && e.kind === 'unreachable') {
			return { ok: false, detail: `Can't reach ${host}.` };
		}
		return { ok: false, detail: errMessage(e) };
	}
	const models = all.map((i) => ({ name: i.id, label: instanceLabel(i) }));
	if (all.length === 0) {
		return {
			ok: false,
			detail: `${host} has no ${kind} models. Add one in llama-toolchest.`,
			models
		};
	}
	const pick = all.find((i) => i.id === chosenId);
	if (!pick) return { ok: false, detail: `No model is chosen — ${section}.`, models };
	if (!usable(pick)) {
		return {
			ok: false,
			detail: `${pick.id} is ${pick.state} — check it in llama-toolchest.`,
			models
		};
	}
	const extra = how ? `, ${how(pick)}` : '';
	const waking = pick.state === 'running' ? '' : ` (${pick.state}: it starts when used)`;
	return { ok: true, detail: `Connected — ${pick.id} on ${host}${waking}${extra}.`, models };
}
