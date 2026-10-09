/**
 * What a Code session shows while the model writes: the answer as it streams,
 * and each tool round — its reasoning and text, and the calls it is writing —
 * until those calls start. Display only: the thread is what `runCodeTurn`
 * returns.
 */

import type { ResolvedToolCall } from '#lib/agent/parser.ts';
import type { SearchStep } from '#lib/agent/loop.ts';
import { newRunningStep } from '#lib/agent/steps.ts';
import { splitRoundForDisplay } from '#lib/agent/textToolCalls.ts';
import type { CodeTurnOptions } from '#lib/code/runCodeTurn.ts';
import { dropPendingCall, upsertPendingCall, type PendingToolCall } from '#lib/code/pendingCall.ts';

/**
 * Where calls written as text are numbered from, apart from the API's own
 * calls in the same round.
 */
const TEXT_CALL_INDEX = 1000;

export class LiveTurn {
	/** The answer so far. */
	streamingContent = $state('');
	/**
	 * The model call in flight while it may still end in tool calls: its
	 * reasoning in `<think>` tags, then any text, without calls written as
	 * text. Cleared when its calls start or the answer begins.
	 */
	roundText = $state('');
	/** Calls the round is writing through the API. */
	private apiCalls = $state<PendingToolCall[]>([]);
	/** Calls the round is writing into its text. */
	private textCalls = $state<PendingToolCall[]>([]);
	/** Tool calls that round is writing, until each starts running. */
	readonly pendingToolCalls = $derived([...this.apiCalls, ...this.textCalls]);
	/** Reasoning from model calls since the last tool started, for its step. */
	private reasoningForStep = '';

	/** The `runCodeTurn` callbacks that feed this. */
	callbacks(): Pick<
		CodeTurnOptions,
		'onAssistantDelta' | 'onRoundStart' | 'onRoundDelta' | 'onToolCallDelta' | 'onReasoning'
	> {
		return {
			onAssistantDelta: (full) => {
				this.streamingContent = full;
				this.clearRound();
			},
			onRoundStart: () => this.clearRound(),
			onRoundDelta: (full) => {
				const { text, calls } = splitRoundForDisplay(full);
				this.roundText = text;
				this.textCalls = calls.map((c, k) => ({ ...c, index: TEXT_CALL_INDEX + k }));
			},
			onToolCallDelta: (index, call) => {
				this.apiCalls = upsertPendingCall(this.apiCalls, index, call);
			},
			onReasoning: (reasoning) => {
				const prev = this.reasoningForStep;
				// One step can follow several calls (a nudge, a retry); keep them apart.
				this.reasoningForStep = prev ? `${prev}\n\n---\n\n${reasoning}` : reasoning;
			}
		};
	}

	/**
	 * The step for a call that starts running. The first of a batch carries the
	 * reasoning and text (`lead`) that led to it; the round it came from is over.
	 */
	startStep(call: ResolvedToolCall, lead?: string): SearchStep {
		const step = newRunningStep(call);
		if (this.reasoningForStep) step.reasoning = this.reasoningForStep;
		if (lead) step.lead = lead;
		this.reasoningForStep = '';
		this.apiCalls = dropPendingCall(this.apiCalls, call);
		this.textCalls = [];
		this.roundText = '';
		return step;
	}

	/** Forget everything. */
	clear(): void {
		this.streamingContent = '';
		this.reasoningForStep = '';
		this.clearRound();
	}

	private clearRound(): void {
		this.roundText = '';
		this.apiCalls = [];
		this.textCalls = [];
	}
}
