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
/**
 * A deliberately large context so the half-the-window clamp never binds —
 * these cases are about which SETTING is chosen. The clamp has its own block
 * below.
 */
function ctxFor(overrides: Partial<AgentLoopOptions> = {}) {
	return buildLoopContext({
		messages: [],
		contextSize: 262144,
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

/**
 * The ceiling doubles as a RESERVATION: `fitMessagesToBudget` derives the
 * prompt budget as `contextSize - reserveOutput`. A ceiling at or above the
 * window leaves nothing for the prompt and collapses the budget to 1 token.
 */
describe('response ceiling vs context window', () => {
	it('caps output at half the window so a prompt budget survives', () => {
		expect(ctxFor({ contextSize: 32768, maxResponseTokens: 32768 }).maxResponseTokens).toBe(16384);
	});

	it('rescues the 8K tier, where the DEFAULT ceiling consumed the whole window', () => {
		// 8192 context against the 8192 default is exactly `8192 - 8192`, which
		// trimmed the conversation to nothing on every turn.
		expect(ctxFor({ contextSize: 8192 }).maxResponseTokens).toBe(4096);
	});

	it('leaves large contexts untouched', () => {
		// 262144 / 2 is far above anything the settings allow, so the clamp is
		// inert exactly where headroom is plentiful.
		updateSettings({ maxResponseTokensFileWrite: 32768 });
		expect(ctxFor({ expectsFileOutput: true }).maxResponseTokens).toBe(32768);
	});

	it('clamps an explicit per-call value too', () => {
		// Shell code mode pins its own budget from settings; it must not be able
		// to out-reserve the window either.
		expect(ctxFor({ contextSize: 16384, maxResponseTokens: 32768 }).maxResponseTokens).toBe(8192);
	});

	it('is inert when the context size is unknown', () => {
		expect(ctxFor({ contextSize: 0, maxResponseTokens: 32768 }).maxResponseTokens).toBe(32768);
	});
});
