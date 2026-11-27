/**
 * Fitting a model call into the window: the prompt fit before the call, and
 * the room left for its response. See `ResponseRoom` in `context.ts`.
 */

import type { ToolDefinition } from '#lib/api.ts';
import {
	estimateMessagesTokens,
	fitMessagesToBudget,
	getTokenCalibration,
	trimOldToolMessages
} from '#lib/agent/contextBudget.ts';
import { logDebug } from '#lib/debugLog.ts';
import {
	inLoopTrimBudget,
	promptReserve,
	recallRoom,
	type LoopContext
} from '#lib/agent/loop/context.ts';

/**
 * Deterministically shrink `ctx.messages` to fit the server's context
 * window before a model call, reserving `reserveOutput` tokens for the
 * response. No-op when context size is unknown (0) or the prompt already
 * fits. Surfaces what it did via the optional `onContextManaged` callback.
 */
export function applyContextGuard(
	ctx: LoopContext,
	reserveOutput: number,
	tools?: ToolDefinition[]
): void {
	if (ctx.contextSize <= 0) return;
	const info = fitMessagesToBudget(ctx.messages, ctx.contextSize, {
		reserveOutput,
		tools,
		calibrationKey: ctx.descriptor.calibrationKey,
		archive: ctx.recallArchive
	});
	if (info) {
		logDebug('agent', 'pre-send context guard reduced prompt', info);
		ctx.options.onContextManaged?.(info);
	}
}

/** Tokens kept clear between the prompt and the response, for estimate error. */
const RESPONSE_ROOM_MARGIN = 256;

/**
 * Stub older tool results when the prompt about to be sent is over the in-loop
 * trim threshold, down to its target (`inLoopTrimBudget`).
 *
 * It runs before the send, on the estimate, rather than after a response on
 * the server's `prompt_tokens`: that count didn't include the tool results
 * the response had just asked for, so a round of big reads went past the
 * threshold and the hard fit in one step, and the fit trimmed instead — to
 * the budget exactly, so the next read went over again. It also works on a
 * backend that reports no usage.
 *
 * Logged because this is otherwise an invisible mutation: when a run degrades
 * in quality rather than failing outright, this is the line that says why.
 */
function trimAhead(ctx: LoopContext, tools?: ToolDefinition[]): void {
	if (ctx.contextSize <= 0) return;
	const calibration = getTokenCalibration(ctx.descriptor.calibrationKey);
	const beforeEst = estimateMessagesTokens(ctx.messages, tools);
	const prompt = Math.ceil(beforeEst * calibration);
	const target = inLoopTrimBudget(ctx.contextSize, prompt);
	if (target === null) return;
	const budget = Math.floor(target / calibration);
	const archive = ctx.recallArchive;
	if (!trimOldToolMessages(ctx.messages, { budget, tools, archive })) return;
	const afterEst = estimateMessagesTokens(ctx.messages, tools);
	logDebug('agent', 'in-loop trim stubbed older tool results', {
		prompt,
		contextSize: ctx.contextSize,
		ratio: +(prompt / ctx.contextSize).toFixed(3),
		after: Math.ceil(afterEst * calibration)
	});
	ctx.options.onContextManaged?.({
		kind: 'trim',
		forced: false,
		trimmedTools: true,
		truncatedMessages: 0,
		droppedTurns: 0,
		beforeEst,
		afterEst
	});
}

/**
 * Fit the prompt for one call, then size its response: whatever room the
 * prompt leaves, up to the turn's ceiling and never below what the fit
 * reserved. Returns the `max_tokens` to send. See `ResponseRoom`.
 */
export function fitForCall(ctx: LoopContext, tools?: ToolDefinition[]): number {
	const reserve = promptReserve(ctx);
	trimAhead(ctx, tools);
	applyContextGuard(ctx, reserve, tools);
	let limit = ctx.maxResponseTokens;
	if (ctx.contextSize > 0) {
		const calibration = getTokenCalibration(ctx.descriptor.calibrationKey);
		const prompt = Math.ceil(estimateMessagesTokens(ctx.messages, tools) * calibration);
		const room = ctx.contextSize - prompt - RESPONSE_ROOM_MARGIN;
		limit = Math.max(reserve, Math.min(ctx.maxResponseTokens, room));
	}
	ctx.responseRoom.limit = limit;
	return limit;
}

/** After a call: if it ran out of room, the next one reserves the ceiling. */
export function noteResponseFinish(ctx: LoopContext, finish: string | null | undefined): void {
	ctx.responseRoom.fullReserve = finish === 'length';
}

/**
 * Start a tool round's recall budget: the room left below the trim threshold
 * with the prompt as it stands, the round's calls message included. Measured
 * like `trimAhead` measures, then turned back into the plain estimate that
 * `recall_result` counts its pages in. A fixed share of the window was not
 * enough: it reset each round, so a second round of recalls still crossed the
 * threshold, and it counted pages uncalibrated, at about two thirds of what
 * they cost (#1022).
 */
export function startRecallRound(ctx: LoopContext): void {
	if (!ctx.recallArchive) return;
	const calibration = getTokenCalibration(ctx.descriptor.calibrationKey);
	const prompt = Math.ceil(estimateMessagesTokens(ctx.messages, ctx.tools) * calibration);
	ctx.recallArchive.startRound(recallRoom(ctx.contextSize, prompt) / calibration);
}
