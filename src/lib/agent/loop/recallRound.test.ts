import { describe, it, expect, beforeEach } from 'vitest';
import { buildLoopContext } from './iteration';
import { startRecallRound } from './responseRoom';
import { RecallArchive } from '#lib/agent/recallArchive.ts';
import {
	estimateMessagesTokens,
	getTokenCalibration,
	resetTokenCalibration
} from '#lib/agent/contextBudget.ts';
import type { AgentLoopOptions } from '#lib/agent/loop.ts';

function ctxWith(text: string, contextSize = 40_000) {
	const ctx = buildLoopContext({
		messages: [
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: text }
		],
		contextSize,
		onStreamChunk: () => {},
		onComplete: () => {},
		onError: () => {},
		onToolStart: () => {},
		onToolEnd: () => {}
	} as AgentLoopOptions);
	ctx.recallArchive = new RecallArchive();
	return ctx;
}

beforeEach(() => resetTokenCalibration());

describe('startRecallRound', () => {
	it('gives the round the room left below the trim threshold, in plain estimate', () => {
		const ctx = ctxWith('x'.repeat(35_000));
		startRecallRound(ctx);
		const calibration = getTokenCalibration(ctx.descriptor.calibrationKey);
		const prompt = Math.ceil(estimateMessagesTokens(ctx.messages, ctx.tools) * calibration);
		const room = (Math.floor(40_000 * 0.7) - prompt) / calibration;
		const archive = ctx.recallArchive!;
		expect(archive.take(room - 10)).toBe(true);
		expect(archive.take(20)).toBe(false);
	});

	it('still lets one recall through when the prompt is past the threshold', () => {
		const ctx = ctxWith('x'.repeat(120_000));
		startRecallRound(ctx);
		const archive = ctx.recallArchive!;
		expect(archive.take(4_000)).toBe(true);
		expect(archive.take(1)).toBe(false);
	});
});
