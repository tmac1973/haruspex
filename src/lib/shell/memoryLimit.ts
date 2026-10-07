import { getSettings } from '#lib/stores/settings.ts';

/** How a one-shot command ended, as far as its memory ceiling goes. */
interface MemoryOutcome {
	out_of_memory: boolean;
	memory_limit_mb: number | null;
}

/** The `memoryLimitPercent` to hand `run_command_capture`. */
export function commandMemoryLimitPercent(): number {
	return getSettings().commandMemoryLimitPercent;
}

/**
 * What the model is told when the kernel killed its command for outgrowing
 * the ceiling. A runaway fails the same way every time, so the point is to
 * stop it re-running the command and send it looking for the allocation.
 */
export function outOfMemoryNote(res: MemoryOutcome): string | null {
	if (!res.out_of_memory) return null;
	const limit =
		res.memory_limit_mb == null
			? 'its memory limit'
			: `its ${(res.memory_limit_mb / 1024).toFixed(1)} GB memory limit`;
	return (
		`Killed: this command went over ${limit}, so the system stopped it. ` +
		'Something it runs allocates without bound: a loop that never ends while it ' +
		'appends, runaway recursion, or loading far more data than intended. It will ' +
		'fail the same way again, so do not re-run it unchanged. Find the cause first, ' +
		'for example by running the failing tests one at a time with a short timeout.'
	);
}
