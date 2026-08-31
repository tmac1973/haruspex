import { describe, it, expect, vi } from 'vitest';

vi.mock('$lib/stores/settings', () => ({
	getSettings: () => ({ customSystemPrompt: '', sandboxEnabled: false }),
	getResponseFormatPrompt: () => '',
	getIncludeImagesPrompt: () => '\n\nIMAGES:\n- When the answer is about something visual',
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

/**
 * The prompt used to give two different answers to "when should I search?":
 * a header naming "products, current events, pricing, or recommendations",
 * and a rule below saying "factual questions". Those contradict, and a model
 * asked "tell me about monkeys" could satisfy the narrower one by not
 * searching at all — observed 1 run in 3 on Qwen 3.6 35B.
 */
describe('buildSystemPrompt — search rules', () => {
	const prompt = () => buildSystemPrompt(null).content as string;

	it('states when to search once, not twice with different scopes', () => {
		const p = prompt();
		// The narrow list was the half the model could hide behind.
		expect(p).not.toContain('products, current events, pricing, or recommendations');
	});

	it('names the shape of question that was being skipped', () => {
		expect(prompt()).toContain('"Tell me about X"');
	});

	it('still says what NOT to search for', () => {
		// Without this half the rule reads as "always search", which would put
		// a web search in front of arithmetic and creative writing.
		const p = prompt();
		expect(p).toContain('Do NOT search');
		expect(p).toMatch(/arithmetic/);
		expect(p).toMatch(/creative writing/);
	});

	it('keeps the fetch and citation rules that follow it', () => {
		const p = prompt();
		expect(p).toContain('Use fetch_url on 2-4 of the most relevant results');
		expect(p).toContain('Only cite sources you actually fetched');
		expect(p).toContain('include Reddit alongside review sites');
	});
});

/**
 * Images are a PARAMETER for the same reason memories are. The IMAGES block
 * must reach the Chat tab and nothing else — a job run, a remote guest and the
 * shell assistant all build their prompts through this function.
 */
describe('buildSystemPrompt — images section', () => {
	it('omits the block when the caller does not ask for it', () => {
		const prompt = buildSystemPrompt(null).content as string;
		expect(prompt).not.toContain('IMAGES:');
	});

	it('omits it when the caller explicitly opts out', () => {
		const prompt = buildSystemPrompt(null, { includeImages: false }).content as string;
		expect(prompt).not.toContain('IMAGES:');
	});

	it('adds it when the caller opts in', () => {
		const prompt = buildSystemPrompt(null, { includeImages: true }).content as string;
		expect(prompt).toContain('IMAGES:');
	});

	/**
	 * The regression that matters most to users who never turn this on: with
	 * the setting off, the prompt must be byte-identical to what it was before
	 * the feature existed.
	 */
	it('leaves the prompt byte-identical when images are off', () => {
		const off = buildSystemPrompt(null, { includeImages: false }).content as string;
		const unset = buildSystemPrompt(null).content as string;
		expect(off).toBe(unset);
	});

	it('composes with memory without either clobbering the other', () => {
		const prompt = buildSystemPrompt(null, {
			includeImages: true,
			memorySection: '\n\nMEMORY — things you learned:\n- Prefers tabs.'
		}).content as string;
		expect(prompt).toContain('IMAGES:');
		expect(prompt).toContain('- Prefers tabs.');
		// Memory stays last so it remains the freshest context.
		expect(prompt.trimEnd().endsWith('- Prefers tabs.')).toBe(true);
	});
});
