/**
 * Specialists: small purpose-tuned models the Code tab's model hands a narrow
 * job to through `ask_specialist`. A specialist is a kind shipped in code
 * (prompt, sampling, params, what to do with the answer) plus the endpoint and
 * model the user picks in Settings → Code → Specialists.
 */
import type { ToolContext, ToolExecOutput } from '#lib/agent/tools/types.ts';

/** How a kind or an entry samples. Every field but `max_tokens` is optional. */
export interface SpecialistSampling {
	temperature?: number;
	top_p?: number;
	top_k?: number;
	min_p?: number;
	max_tokens: number;
	/**
	 * Sent as `enable_thinking` when set; absent leaves the server's default.
	 * Some small models think until they run out of tokens.
	 */
	thinking?: boolean;
}

/** A field a kind adds to `ask_specialist`, as a JSON-schema property. */
export interface SpecialistParam {
	schema: Record<string, unknown>;
	required: boolean;
}

/** One specialist the user set up: stored in `AppSettings.specialists`. */
export interface SpecialistEntry {
	/** Stable across edits: `crypto.randomUUID()`. */
	id: string;
	/** What Settings shows and the model names. */
	name: string;
	/** A registered kind's id. */
	kind: string;
	/** The server's base URL. */
	url: string;
	/** A named key from Settings → Inference → API Keys, or none. */
	keyId: string | null;
	model: string;
	/** Null: the kind's default. */
	description: string | null;
	/** Null: the kind's default. `''`: send no system message. */
	systemPrompt: string | null;
	/** Null: the kind's default; otherwise overrides field by field. */
	sampling: Partial<SpecialistSampling> | null;
	/** New Code sessions offer it until the session says otherwise. */
	onByDefault: boolean;
	/**
	 * The server takes images for this model (for llama.cpp, the vision
	 * projector is loaded). The user's setting, not the kind's.
	 */
	acceptsImages: boolean;
}

/** A reference image from the session folder. */
export interface SpecialistImage {
	path: string;
	dataUrl: string;
}

/** One call, as `ask_specialist` hands it to a kind. */
export interface SpecialistRun {
	entry: SpecialistEntry;
	/** Undefined when the call had none; always set for a kind that requires one. */
	request: string | undefined;
	images: SpecialistImage[];
	args: Record<string, unknown>;
	ctx: ToolContext;
}

export interface SpecialistKind {
	id: string;
	/** Settings' name for the kind. */
	label: string;
	/** Settings' one-line summary. */
	summary: string;
	/** Tells the main model when to use a specialist of this kind. */
	defaultDescription: string;
	defaultSystemPrompt: string;
	defaultSampling: SpecialistSampling;
	/** Writes into the session folder: refused in a read-only session. */
	writes: boolean;
	/** Fields the kind adds to the tool, by name. */
	params: Record<string, SpecialistParam>;
	/** False only for a kind with a mode that takes no request. */
	requestRequired: boolean;
	/** The tool card's label for a call, or null for the default one. */
	callLabel?(entry: SpecialistEntry, args: Record<string, unknown>): string | null;
	run(run: SpecialistRun): Promise<ToolExecOutput>;
}
