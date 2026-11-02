/**
 * One request to a specialist: its system prompt and sampling, streamed so
 * the tool card can show progress, and queued so it never contends with the
 * turn that asked for it.
 */
import { chatCompletionStream, type BackendOverride, type ChatMessage } from '#lib/api.ts';
import { withInferenceSlot } from '#lib/agent/inferenceQueue.svelte.ts';
import type { SlotLender, ToolContext } from '#lib/agent/tools/types.ts';
import { resolveBackendDescriptor } from '#lib/inference/descriptor.ts';
import { probeInferenceServer } from '#lib/inferenceProbe.ts';
import {
	effectiveSampling,
	effectiveSystemPrompt,
	entryBackend,
	specialistBaseUrl
} from '#lib/specialists/entries.ts';
import type { SpecialistEntry, SpecialistImage } from '#lib/specialists/types.ts';

export interface SpecialistCallOptions {
	signal?: AbortSignal;
	onProgress?: (status: string) => void;
	/**
	 * Called from a turn's tool. A same-server call then shares the turn's
	 * slot rather than queueing behind it, which would never be admitted on
	 * a one-slot server.
	 */
	inTurn?: boolean;
	/** The turn's model; null or absent means Settings. */
	turnBackend?: BackendOverride | null;
	/** The turn's slot lender, when its tools run side by side. */
	runInSlot?: SlotLender;
	/** Replaces the sampling's `max_tokens`. */
	maxTokens?: number;
	images?: SpecialistImage[];
}

export interface SpecialistAnswer {
	content: string;
	reasoning: string;
	/** `length` when it ran out of tokens; kinds decide what that means. */
	finishReason: string | null;
	completionTokens: number | null;
}

/** How often the tool card's token count moves. */
const PROGRESS_MS = 500;

/** The options a kind passes for a call from `ask_specialist`. */
export function callOptionsFrom(ctx: ToolContext): SpecialistCallOptions {
	return {
		signal: ctx.signal,
		onProgress: ctx.onProgress,
		inTurn: true,
		turnBackend: ctx.backend,
		runInSlot: ctx.runInSlot
	};
}

function buildMessages(
	entry: SpecialistEntry,
	request: string,
	images: SpecialistImage[]
): ChatMessage[] {
	const messages: ChatMessage[] = [];
	const system = effectiveSystemPrompt(entry);
	if (system) messages.push({ role: 'system', content: system });
	messages.push({
		role: 'user',
		content: images.length
			? [
					...images.map((img) => ({
						type: 'image_url' as const,
						image_url: { url: img.dataUrl }
					})),
					{ type: 'text' as const, text: request }
				]
			: request
	});
	return messages;
}

export async function callSpecialist(
	entry: SpecialistEntry,
	request: string,
	opts: SpecialistCallOptions = {}
): Promise<SpecialistAnswer> {
	const images = opts.images ?? [];
	if (images.length && !entry.acceptsImages) {
		throw new Error(`${entry.name} doesn't take images.`);
	}
	const backend = entryBackend(entry);
	const { thinking, max_tokens, ...sampling } = effectiveSampling(entry);
	const messages = buildMessages(entry, request, images);

	const stream = async (): Promise<SpecialistAnswer> => {
		let content = '';
		let reasoning = '';
		let finishReason: string | null = null;
		let completionTokens: number | null = null;
		let chunks = 0;
		let lastProgress = 0;
		for await (const chunk of chatCompletionStream(
			{
				messages,
				backend,
				...sampling,
				max_tokens: opts.maxTokens ?? max_tokens,
				...(thinking === undefined ? {} : { chat_template_kwargs: { enable_thinking: thinking } })
			},
			opts.signal
		)) {
			const text = chunk.delta.content ?? '';
			const thought = chunk.delta.reasoning_content ?? chunk.delta.reasoning ?? '';
			content += text;
			reasoning += thought;
			if (text || thought) chunks++;
			if (chunk.finish_reason) finishReason = chunk.finish_reason;
			if (chunk.usage?.completion_tokens != null) completionTokens = chunk.usage.completion_tokens;
			const now = Date.now();
			if (opts.onProgress && now - lastProgress >= PROGRESS_MS) {
				lastProgress = now;
				opts.onProgress(`${entry.name}: ${chunks.toLocaleString()} tokens`);
			}
		}
		return { content, reasoning, finishReason, completionTokens };
	};

	const turnBase = specialistBaseUrl(
		resolveBackendDescriptor(opts.turnBackend ?? undefined).baseUrl
	);
	if (opts.inTurn && turnBase === backend.baseUrl) {
		return opts.runInSlot ? opts.runInSlot(() => stream(), { signal: opts.signal }) : stream();
	}
	return withInferenceSlot({ consumer: 'subagent', backend, signal: opts.signal }, () => stream());
}

/**
 * The model ids `entry`'s server lists, for the editor's Fetch button. Asked
 * through the probe Settings → Inference uses, in Rust: a server that answers
 * a chat request's CORS check may still send none for its model list
 * (llama-toolchest's `/v1/models`).
 */
export async function listSpecialistModels(entry: SpecialistEntry): Promise<string[]> {
	const probe = await probeInferenceServer(entryBackend(entry).baseUrl, entry.keyId);
	return probe.models.map((m) => m.id);
}
