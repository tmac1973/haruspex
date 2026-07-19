import { describe, it, expect, afterEach } from 'vitest';
import { buildLoopContext } from './iteration';
import { updateSettings, getSettings } from '$lib/stores/settings';
import type { AgentLoopOptions } from '$lib/agent/loop';

/**
 * The ceiling is resolved in `buildLoopContext` rather than in
 * `runEphemeralTurn` on purpose: that is the single point every entry into the
 * agent loop passes through. Resolving it one layer up covered jobs only and
 * left the chat tab — which calls `runAgentLoop` directly and can itself be a
 * file-writing turn — pinned to the fallback constant.
 */
function ctxFor(overrides: Partial<AgentLoopOptions> = {}) {
	return buildLoopContext({
		messages: [],
		contextSize: 32768,
		onStreamChunk: () => {},
		onComplete: () => {},
		onError: () => {},
		...overrides
	} as AgentLoopOptions);
}

const original = {
	base: getSettings().maxResponseTokens,
	file: getSettings().maxResponseTokensFileWrite
};

afterEach(() => {
	updateSettings({
		maxResponseTokens: original.base,
		maxResponseTokensFileWrite: original.file
	});
});

describe('response token ceiling resolution', () => {
	it('uses the base ceiling for a normal turn', () => {
		expect(ctxFor().maxResponseTokens).toBe(8192);
	});

	it('uses the larger file-write ceiling when the turn must produce a file', () => {
		expect(ctxFor({ expectsFileOutput: true }).maxResponseTokens).toBe(32768);
	});

	it('lets an explicit per-call value win over both settings', () => {
		// Shell code mode pins its own budget; settings must not override it.
		const ctx = ctxFor({ expectsFileOutput: true, maxResponseTokens: 16384 });
		expect(ctx.maxResponseTokens).toBe(16384);
	});

	it('tracks a change to the setting', () => {
		updateSettings({ maxResponseTokens: 4096, maxResponseTokensFileWrite: 65536 });
		expect(ctxFor().maxResponseTokens).toBe(4096);
		expect(ctxFor({ expectsFileOutput: true }).maxResponseTokens).toBe(65536);
	});

	it('applies to a chat-shaped turn, not just job turns', () => {
		// The regression this file exists for: chat.svelte.ts calls runAgentLoop
		// directly and passes expectsFileOutput, so a chat turn that writes a file
		// must get the file-write ceiling too — it used to get a hardcoded 8192.
		updateSettings({ maxResponseTokensFileWrite: 65536 });
		const chatTurn = ctxFor({
			workingDir: '/tmp/work',
			interactive: true,
			expectsFileOutput: true
		});
		expect(chatTurn.maxResponseTokens).toBe(65536);
	});
});
