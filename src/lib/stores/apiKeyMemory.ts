/**
 * Inference API keys read back from the secret store, held in memory only.
 *
 * A dependency-free leaf so `settings.ts` can read it synchronously without an
 * import cycle; `apiKeySecrets.ts` fills it.
 */
const memory = new Map<string, string>();

export function rememberApiKey(id: string, value: string): void {
	memory.set(id, value);
}

export function rememberedApiKey(id: string): string | undefined {
	return memory.get(id);
}

export function forgetApiKey(id: string): void {
	memory.delete(id);
}
