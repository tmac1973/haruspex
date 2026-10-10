import { describe, it, expect } from 'vitest';
import {
	encodeCodeSession,
	decodeCodeSession,
	CODE_SESSION_VERSION,
	type CodeSessionState
} from '#lib/code/session.ts';

function state(over: Partial<CodeSessionState> = {}): CodeSessionState {
	return {
		messages: [
			{ role: 'user', content: 'add a test' },
			{ role: 'assistant', content: 'done' }
		],
		messageSteps: {},
		messageStats: {},
		messageStops: {},
		messageHistorySent: {},
		compaction: null,
		...over
	};
}

describe('code session persistence', () => {
	it('round-trips a thread with its index-keyed sidecars', () => {
		const original = state({
			messageSteps: { 1: [{ name: 'run_command', status: 'done' }] as never },
			messageStats: { 1: { tokensPerSecond: 50, completionTokens: 100, durationMs: 2000 } },
			messageStops: { 1: 'turn-limit' as never },
			messageHistorySent: { 0: ['ls -la'] }
		});
		const decoded = decodeCodeSession(encodeCodeSession(original));
		expect(decoded).toEqual(original);
	});

	it('rejects a payload from a different version rather than mis-decoding it', () => {
		const encoded = JSON.parse(encodeCodeSession(state()));
		encoded.version = CODE_SESSION_VERSION + 1;
		expect(decodeCodeSession(JSON.stringify(encoded))).toBeNull();
	});

	it('rejects absent, corrupt, and non-object payloads', () => {
		expect(decodeCodeSession(null)).toBeNull();
		expect(decodeCodeSession('')).toBeNull();
		expect(decodeCodeSession('{not json')).toBeNull();
		expect(decodeCodeSession('"a string"')).toBeNull();
		expect(decodeCodeSession('null')).toBeNull();
	});

	it('rejects an empty thread, so a restore never announces nothing', () => {
		expect(decodeCodeSession(encodeCodeSession(state({ messages: [] })))).toBeNull();
	});

	it('tolerates a payload missing its sidecars', () => {
		const encoded = JSON.parse(encodeCodeSession(state()));
		delete encoded.messageSteps;
		delete encoded.messageStats;
		const decoded = decodeCodeSession(JSON.stringify(encoded));
		expect(decoded?.messages).toHaveLength(2);
		expect(decoded?.messageSteps).toEqual({});
	});

	it('round-trips a compaction', () => {
		const original = state({ compaction: { at: 1, summary: 'Added a test.', summarizedAt: 5 } });
		expect(decodeCodeSession(encodeCodeSession(original))).toEqual(original);
	});

	it('reads a payload from before compaction as uncompacted', () => {
		const encoded = JSON.parse(encodeCodeSession(state()));
		delete encoded.compaction;
		expect(decodeCodeSession(JSON.stringify(encoded))?.compaction).toBeNull();
	});

	it('drops a compaction it cannot use, keeping the thread', () => {
		for (const bad of [
			{ at: 0, summary: 's' },
			{ at: 3, summary: 's' },
			{ at: 1.5, summary: 's' },
			{ at: '1', summary: 's' },
			{ at: 1, summary: '  ' },
			{ at: 1 },
			'garbage'
		]) {
			const encoded = JSON.parse(encodeCodeSession(state()));
			encoded.compaction = bad;
			const decoded = decodeCodeSession(JSON.stringify(encoded));
			expect(decoded?.messages, JSON.stringify(bad)).toHaveLength(2);
			expect(decoded?.compaction, JSON.stringify(bad)).toBeNull();
		}
	});
});
