import { invoke } from '@tauri-apps/api/core';
import { inlineSecrets } from '#lib/engine/settings.ts';

/**
 * Lines made fit for a public issue (`feedback.rs`). Passes along the secrets
 * the settings hold inline, on a computer with no secret store, since Rust
 * never sees those otherwise.
 */
export function redactForReport(lines: string[]): Promise<string[]> {
	return invoke<string[]>('feedback_redact', { lines, inline: inlineSecrets() });
}
