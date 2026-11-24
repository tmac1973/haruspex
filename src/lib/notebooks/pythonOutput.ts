/**
 * A Python card's saved output (`meta.output`): what its last run printed
 * and drew. Apart from `pythonRun.ts` so showing a card (the web client
 * too) needs nothing of the sandbox.
 */
import * as api from '#lib/notebooks/api.ts';
import type { NotebookCard } from '#lib/notebooks/api.ts';
import type { Artifact } from '#lib/sandbox/protocol.ts';

/** What a run leaves on the card (`meta.output`). */
export interface PythonOutput {
	stdout: string;
	stderr: string;
	/** The last expression's value, as Python shows it. */
	result: string;
	error: string | null;
	artifacts: Artifact[];
	duration_ms: number;
	ran_at: number;
	/** Each table read, and its version then: newer means the output is stale. */
	read_versions: Record<string, number>;
	/** `result` as CSV, when it was a DataFrame. */
	result_csv?: string;
	/** Notes on what was left out (pictures too big to keep). */
	notes: string[];
}

export function outputOf(card: NotebookCard): PythonOutput | null {
	const out = api.parseMeta<{ output?: PythonOutput }>(card.meta).output;
	return out && typeof out === 'object' ? out : null;
}
