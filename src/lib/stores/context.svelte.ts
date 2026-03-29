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

export function getContextPercentage(): number {
	if (usage.contextSize === 0) return 0;
	return (usage.promptTokens / usage.contextSize) * 100;
}
