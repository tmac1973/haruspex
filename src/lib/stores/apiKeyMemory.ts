/**
 * Inference API keys read back from the secret store, held in memory only.
 *
 * A dependency-free leaf so `settings.ts` can read it synchronously without an
 * import cycle; `apiKeySecrets.ts` fills it.
 */
const memory = new Map<string, string>();

/**
 * Why a key the settings call stored has no value this run: the store had
 * nothing under its name, or refused the read. Cleared when a value arrives.
 */
export type ApiKeyProblem = 'missing' | 'unreadable';

const problems = new Map<string, ApiKeyProblem>();

export function rememberApiKey(id: string, value: string): void {
	memory.set(id, value);
	problems.delete(id);
}

export function rememberedApiKey(id: string): string | undefined {
	return memory.get(id);
}

export function forgetApiKey(id: string): void {
	memory.delete(id);
	problems.delete(id);
}

export function markApiKeyProblem(id: string, problem: ApiKeyProblem): void {
	problems.set(id, problem);
}

export function apiKeyProblem(id: string): ApiKeyProblem | undefined {
	return problems.get(id);
}
