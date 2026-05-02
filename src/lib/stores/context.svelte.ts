import type { Usage } from '$lib/api';

interface ContextUsage {
	promptTokens: number;
	completionTokens: number;
	contextSize: number;
}

let usage = $state<ContextUsage>({
	promptTokens: 0,
	completionTokens: 0,
	contextSize: 0
});

export function getContextUsage(): ContextUsage {
	return usage;
}

export function updateContextUsage(apiUsage: Usage, contextSize: number): void {
	usage = {
		promptTokens: apiUsage.prompt_tokens,
		completionTokens: apiUsage.completion_tokens,
		contextSize
	};
}

export function resetContextUsage(): void {
	usage = {
		promptTokens: 0,
		completionTokens: 0,
		contextSize: usage.contextSize
	};
}

/** Restore saved token counts (e.g., when switching back to a previous chat tab). */
export function setContextUsage(promptTokens: number, completionTokens: number): void {
	usage = {
		promptTokens,
		completionTokens,
		contextSize: usage.contextSize
	};
}

/** Update just the context size, preserving token counts. Used when the
 *  active inference backend changes (e.g. remote→local) so the indicator
 *  reflects the new ceiling without waiting for the next prompt. */
export function setContextSize(contextSize: number): void {
	usage = { ...usage, contextSize };
}

export function getContextPercentage(): number {
	if (usage.contextSize === 0) return 0;
	return (usage.promptTokens / usage.contextSize) * 100;
}
