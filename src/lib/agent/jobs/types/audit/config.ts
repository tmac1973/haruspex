/**
 * Audit `type_config` JSON shape. One parser serves both consumers: the
 * pipeline (runtime semantics — null means "runner default") and the editor
 * mappers in definition.ts (presentation defaults applied on top).
 */

import { finiteOrNull, nonEmptyOrNull } from '#lib/utils/coerce.ts';

export interface AuditConfig {
	/** Independent sample runs. null = runner default (3). */
	num_runs: number | null;
	/** Meta-report file relative to working_dir. null = don't write a file. */
	output_file: string | null;
	/** Sample + verification turns use a read-only tool subset. */
	read_only: boolean;
	/** Per-sample agent-loop turn budget. null = runner default (200). */
	max_iterations: number | null;
	/** Custom sample-run instructions. null = built-in default. */
	sample_instructions: string | null;
	/** Custom verification rubric. null = built-in default. */
	verify_instructions: string | null;
}

export function parseAuditConfig(json: string | null): AuditConfig {
	let raw: Record<string, unknown> = {};
	if (json) {
		try {
			const parsed: unknown = JSON.parse(json);
			if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
		} catch {
			// Malformed config behaves like no config — runner defaults.
		}
	}
	return {
		num_runs: finiteOrNull(raw.num_runs),
		output_file: nonEmptyOrNull(raw.output_file),
		read_only: typeof raw.read_only === 'boolean' ? raw.read_only : true,
		max_iterations: finiteOrNull(raw.max_iterations),
		sample_instructions: nonEmptyOrNull(raw.sample_instructions),
		verify_instructions: nonEmptyOrNull(raw.verify_instructions)
	};
}
