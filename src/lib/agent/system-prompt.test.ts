import { describe, it, expect, vi } from 'vitest';

vi.mock('$lib/stores/settings', () => ({
	getSettings: () => ({ customSystemPrompt: '', sandboxEnabled: false }),
	getResponseFormatPrompt: () => '',
	hasEnabledEmailAccount: () => false
}));

import { buildSystemPrompt } from './system-prompt';

/**
 * Memory is a PARAMETER, not something this module fetches. Job runs, remote
 * guests and the shell assistant all build their prompts through here, and
 * the plan's "chat only" scope is enforced by that signature — a caller that
 * does not pass memories cannot receive them by accident.
 */
describe('buildSystemPrompt — memory section', () => {
	it('omits the section entirely when no memories are passed', () => {
		const prompt = buildSystemPrompt(null).content as string;
		expect(prompt).not.toContain('MEMORY');
	});

	it('omits it for a caller that passes an empty section', () => {
		const prompt = buildSystemPrompt(null, { memorySection: '' }).content as string;
		expect(prompt).not.toContain('MEMORY');
	});

	it('appends the section when one is supplied', () => {
		const section = '\n\nMEMORY — things you learned:\n- Prefers tabs.';
		const prompt = buildSystemPrompt(null, { memorySection: section }).content as string;
		expect(prompt).toContain('- Prefers tabs.');
		// At the end, after the custom instructions and format rules, so it is
		// the freshest context rather than something buried mid-prompt.
		expect(prompt.trimEnd().endsWith('- Prefers tabs.')).toBe(true);
	});

	it('still builds a single system message', () => {
		// Strict chat templates reject a non-first system message, so memory
		// has to ride the one leading system message.
		const msg = buildSystemPrompt(null, { memorySection: '\n\nMEMORY — x' });
		expect(msg.role).toBe('system');
	});
});
