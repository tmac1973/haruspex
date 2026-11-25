/**
 * The 3D delegate's settings (Settings → Code → Helpers → 3D), stored as plain
 * JSON under the 3D helper's id in `codeHelperConfig`: the model `delegate_3d`
 * hands assets to, and the caps on one call. A Code session can name its own
 * model (Extras → 3D delegate), stored as `{ backend }` under `'3d'` in the
 * session's helper settings; the caps always come from Settings.
 */
import type { BackendOverride } from '#lib/api.ts';
import type { SessionHelperConfig } from '#lib/code/db.ts';
import { getSettings } from '#lib/stores/settings.ts';

export interface Delegate3dConfig {
	/** The delegate's model; null means none, so `delegate_3d` is not offered. */
	backend: BackendOverride | null;
	/** The most model rounds one call takes. */
	maxRounds: number;
	/** The most one call may spend in USD; null for no limit. */
	maxCostUsd: number | null;
}

export const DELEGATE_3D_DEFAULTS: Delegate3dConfig = {
	backend: null,
	maxRounds: 80,
	maxCostUsd: null
};

export const MIN_DELEGATE_ROUNDS = 5;
export const MAX_DELEGATE_ROUNDS = 500;

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isRecord = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === 'object' && !Array.isArray(v);

/** A stored backend, or null when it lacks a server or a model. */
function parseBackend(raw: unknown): BackendOverride | null {
	if (!isRecord(raw) || !nonEmpty(raw.baseUrl) || !nonEmpty(raw.modelId)) return null;
	const out: BackendOverride = { baseUrl: raw.baseUrl.trim(), modelId: raw.modelId.trim() };
	if (nonEmpty(raw.apiKey)) out.apiKey = raw.apiKey;
	if (nonEmpty(raw.apiKeyId)) out.apiKeyId = raw.apiKeyId;
	if (typeof raw.contextSize === 'number' && raw.contextSize > 0) {
		out.contextSize = raw.contextSize;
	}
	if (typeof raw.visionSupported === 'boolean') out.visionSupported = raw.visionSupported;
	if (isRecord(raw.discovered)) {
		out.discovered = raw.discovered as NonNullable<BackendOverride['discovered']>;
	}
	return out;
}

/** A round cap: a whole number within `MIN_DELEGATE_ROUNDS`–`MAX_DELEGATE_ROUNDS`. */
export function clampDelegateRounds(raw: unknown): number {
	if (typeof raw !== 'number' || !Number.isFinite(raw)) return DELEGATE_3D_DEFAULTS.maxRounds;
	return Math.min(MAX_DELEGATE_ROUNDS, Math.max(MIN_DELEGATE_ROUNDS, Math.round(raw)));
}

/** Whatever is stored (absent, old or hand-edited), as a `Delegate3dConfig`. */
export function parseDelegate3dConfig(raw: unknown): Delegate3dConfig {
	const r = isRecord(raw) ? raw : {};
	const cost = r.maxCostUsd;
	return {
		backend: parseBackend(r.backend),
		maxRounds: clampDelegateRounds(r.maxRounds),
		maxCostUsd: typeof cost === 'number' && Number.isFinite(cost) && cost > 0 ? cost : null
	};
}

/**
 * A session's own delegate model from its helper settings: a model, null for
 * none in this session, or undefined when it follows Settings.
 */
export function sessionDelegateBackend(
	session: SessionHelperConfig | null | undefined
): BackendOverride | null | undefined {
	const entry = session?.['3d'];
	if (!isRecord(entry) || !('backend' in entry)) return undefined;
	return parseBackend(entry.backend);
}

/** `session` with its own delegate model set, or cleared back to Settings (`undefined`). */
export function withSessionDelegate(
	session: SessionHelperConfig | null,
	backend: BackendOverride | null | undefined
): SessionHelperConfig | null {
	const rest = { ...session };
	delete rest['3d'];
	const next = backend === undefined ? rest : { ...rest, '3d': { backend } };
	return Object.keys(next).length > 0 ? next : null;
}

/**
 * The 3D delegate's settings as stored now, with `session`'s own model in
 * place of the Settings one when it names one. Read straight from the store,
 * not through `helperConfig`, so the tool filter gets them whether or not the
 * 3D helper's module is loaded.
 */
export function delegate3dConfig(session?: SessionHelperConfig | null): Delegate3dConfig {
	const config = parseDelegate3dConfig(getSettings().codeHelperConfig?.['3d']);
	const own = sessionDelegateBackend(session);
	return own === undefined ? config : { ...config, backend: own };
}
