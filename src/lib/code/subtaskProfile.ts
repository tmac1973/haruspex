/**
 * A subtask profile: a subtask that runs on a model of its own, with its own
 * prompt, a fixed tool list, a writable-path limit, caps on its rounds and
 * spend, and a check in code that it finished. `delegate`'s subtasks have
 * none; the 3D delegate is built on one.
 *
 * A profiled subtask writes straight into the session's folder (no worktree),
 * limited to `writablePaths`.
 */
import type { BackendOverride, Usage } from '#lib/api.ts';
import type { CodeWriteGuard } from '#lib/agent/tools/types.ts';
import type { SearchStep } from '#lib/agent/loop.ts';
import type { SubtaskResult } from '#lib/code/runSubtask.ts';
import { laneKey } from '#lib/agent/inferenceQueue.svelte.ts';
import { resolveBackendDescriptor } from '#lib/inference/descriptor.ts';
import { getOpenRouterCatalog } from '#lib/stores/openrouterCatalog.svelte.ts';
import { callCostUsd, catalogPrices } from '#lib/code/usageTotals.ts';

/** Why a profiled subtask was stopped before it finished on its own. */
export type SubtaskCap = 'rounds' | 'cost';

/**
 * What a profile's own checks get from the run: the folder's write lease, for
 * a write of their own (the turn's, or a background subtask's per-write one).
 */
export interface ProfileRun {
	guard?: CodeWriteGuard;
}

/** The run's totals, the figures its card shows. */
export interface SubtaskUsage {
	tokens: number;
	/** USD; null when no call had a known price. */
	costUsd: number | null;
}

export interface SubtaskProfile {
	/** The model it runs on. */
	backend: BackendOverride;
	/** The whole system prompt. */
	system: string;
	/** The one user message it starts with. */
	firstMessage: string;
	/** Pictures sent with the first message, when its model can see them. */
	images: { path: string; dataUrl: string }[];
	/** Exactly the tools it is offered (the loop's `toolAllowlist`). */
	tools: string[];
	/** Helper ids whose tools it may have (`ToolSchemaOpts.subtaskHelpers`). */
	helpers: string[];
	/** The only files it may write (`ToolContext.writablePaths`). */
	writablePaths: string[];
	/** The most model rounds it takes, counting a nudged pass too. */
	maxRounds: number;
	/** The most it may spend in USD; null for no limit. */
	maxCostUsd: number | null;
	/** Once it ends on its own: a nudge to send it back with (once), or null when it is done. */
	doneCheck?: (steps: SearchStep[], run: ProfileRun) => Promise<string | null>;
	/** The user message for its last call, with no tools, when a cap stopped it. */
	finalReport: (why: SubtaskCap) => string;
	/**
	 * What the parent is told once the run ends, and a picture for the card
	 * (`SubtaskState.sheet`). Without it the generic subtask text is used.
	 */
	finish?: (
		res: SubtaskResult,
		usage: SubtaskUsage,
		run: ProfileRun & { stoppedByUser: boolean }
	) => Promise<{ text: string; png?: string }>;
	/** Called once when the run is over, however it ended, even if it never started. */
	onEnd?: () => void;
}

/**
 * Whose inference slot a profiled subtask runs in: the parent's, when both
 * are on one lane, or one of its own, so a remote model's work never holds or
 * borrows the parent's local slot.
 */
export function profileLane(
	profile: Pick<SubtaskProfile, 'backend'>,
	parentBackend: BackendOverride | null | undefined
): 'parent' | 'own' {
	return laneKey(profile.backend) === laneKey(parentBackend ?? undefined) ? 'parent' : 'own';
}

/**
 * What one call on `backend` cost in USD: the price the server reported, else
 * for OpenRouter one worked out from its catalogue. Null when the call has no
 * known price (a local or self-hosted server).
 */
export function subtaskCallCost(
	usage: Usage,
	backend: BackendOverride | null | undefined
): number | null {
	if (typeof usage.cost === 'number' && Number.isFinite(usage.cost)) return usage.cost;
	const descriptor = resolveBackendDescriptor(backend ?? undefined);
	if (descriptor.kind !== 'openrouter') return null;
	return callCostUsd(usage, catalogPrices(getOpenRouterCatalog(), descriptor.modelId));
}
