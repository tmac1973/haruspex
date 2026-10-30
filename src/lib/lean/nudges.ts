/**
 * Lean mode's two one-time nudges. Neither changes anything by itself:
 *
 * - an existing user, who never saw the setup wizard's Lean or Full step,
 *   is offered lean mode once when the recommendation fits (`shouldOfferLean`);
 * - a lean user who switches to a model that can run the full app sees a dot
 *   on the header badge, once for that model (`shouldHintFull`).
 */
import { invoke } from '@tauri-apps/api/core';
import { parseParamsB } from '#lib/agent/mcpBudget.ts';
import { activeModelId, LEAN_MAX_PARAMS_B, recommendLean } from '#lib/lean/recommend.ts';
import {
	getSettings,
	markLeanHinted,
	setLeanMode,
	type AppSettings
} from '#lib/stores/settings.ts';
import type { HardwareInfo } from '#lib/stores/setup.svelte.ts';

/**
 * Whether to offer lean mode to someone who never answered the wizard's
 * step. The model's size decides first; only when it doesn't is the
 * hardware asked about, and never for a remote model, which runs elsewhere.
 */
export async function shouldOfferLean(): Promise<boolean> {
	const s = getSettings();
	if (s.leanMode || s.leanNoticeShown) return false;
	const modelId = activeModelId(s);
	// No model yet: this is a first run, and the wizard will ask.
	if (!modelId) return false;
	if (recommendLean({ modelId, hardware: null }).lean) return true;
	if (s.inferenceBackend.mode !== 'local') return false;
	const hardware = await invoke<HardwareInfo>('hardware_detect');
	return recommendLean({ modelId, hardware }).lean;
}

/**
 * Whether the badge should say this model can run the full app: lean mode
 * is on, the model is bigger than lean mode is meant for (or a remote one
 * whose name doesn't say), and it hasn't been hinted at or switched on.
 * Hardware isn't asked: a bigger model that has loaded is already running.
 */
export function shouldHintFull(modelId: string | null, s: AppSettings): boolean {
	if (!s.leanMode || !modelId || s.leanHintedModels.includes(modelId)) return false;
	const params = parseParamsB(modelId);
	if (params !== null) return params > LEAN_MAX_PARAMS_B;
	return s.inferenceBackend.mode === 'remote';
}

/**
 * Switch lean mode, from the Settings switch or the notice. The model in use
 * now is the one the switch was made for, so it never gets the hint.
 */
export function turnLeanMode(on: boolean): void {
	markLeanHinted(activeModelId());
	setLeanMode(on);
}
