/**
 * Whether to recommend lean mode (Settings → General → Lean mode): for a
 * model of 9B or smaller, which can't do the coding and shell work well, or
 * for a machine without a fast GPU, where every tool schema costs minutes.
 * The setup wizard pre-selects what this says; the user decides.
 */
import { parseParamsB } from '#lib/agent/mcpBudget.ts';
import { getSettings, type AppSettings } from '#lib/stores/settings.ts';
import type { HardwareInfo } from '#lib/stores/setup.svelte.ts';

/** The largest model, in billions of parameters, lean mode is recommended for. */
export const LEAN_MAX_PARAMS_B = 9;

export type LeanReason = 'small-model' | 'weak-hardware' | null;

export interface LeanRecommendation {
	lean: boolean;
	reason: LeanReason;
}

/**
 * The model in use, by the name its size can be read from: the local weights
 * file, or the remote server's model id.
 */
export function activeModelId(s: AppSettings = getSettings()): string | null {
	return s.inferenceBackend.mode === 'local'
		? s.activeLocalModelFilename || null
		: s.inferenceBackend.remoteModelId || null;
}

/**
 * The recommendation for `modelId` on `hardware`. A model whose size can't be
 * read is taken as a capable one, and `hardware` is null when the model
 * doesn't run on this machine (a remote server).
 */
export function recommendLean(input: {
	modelId: string | null;
	hardware: Pick<HardwareInfo, 'gpu_available' | 'gpu_integrated_slow'> | null;
}): LeanRecommendation {
	const params = parseParamsB(input.modelId);
	if (params !== null && params <= LEAN_MAX_PARAMS_B) return { lean: true, reason: 'small-model' };
	const hw = input.hardware;
	if (hw && (!hw.gpu_available || hw.gpu_integrated_slow)) {
		return { lean: true, reason: 'weak-hardware' };
	}
	return { lean: false, reason: null };
}
