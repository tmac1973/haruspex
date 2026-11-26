/**
 * Fitting a model call into the window: the prompt fit before the call, and
 * the room left for its response. See `ResponseRoom` in `context.ts`.
 */

import type { ToolDefinition } from '#lib/api.ts';
import {
	estimateMessagesTokens,
	fitMessagesToBudget,
	getTokenCalibration
} from '#lib/agent/contextBudget.ts';
import { logDebug } from '#lib/debugLog.ts';
import { promptReserve, type LoopContext } from '#lib/agent/loop/context.ts';

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
		calibrationKey: ctx.descriptor.calibrationKey
	});
	if (info) {
		logDebug('agent', 'pre-send context guard reduced prompt', info);
		ctx.options.onContextManaged?.(info);
	}
}

/** Tokens kept clear between the prompt and the response, for estimate error. */
const RESPONSE_ROOM_MARGIN = 256;

/**
 * Fit the prompt for one call, then size its response: whatever room the
 * prompt leaves, up to the turn's ceiling and never below what the fit
 * reserved. Returns the `max_tokens` to send. See `ResponseRoom`.
 */
export function fitForCall(ctx: LoopContext, tools?: ToolDefinition[]): number {
	const reserve = promptReserve(ctx);
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
