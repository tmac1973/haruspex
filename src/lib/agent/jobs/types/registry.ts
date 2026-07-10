/**
 * Job-type registry (job-plugins Phase 02), modeled on the tool registry:
 * type modules self-register a `JobTypeDefinition`; the runner and the job
 * editor dispatch through lookups instead of `job_type === ...` branches.
 * Import `./index.ts` (the registration barrel), not this module, from
 * anything that needs the built-in types registered.
 */

import type { JobTypeDefinition } from './types';

const jobTypes = new Map<string, JobTypeDefinition>();

export function registerJobType(def: JobTypeDefinition): void {
	jobTypes.set(def.id, def);
}

export function getJobType(id: string): JobTypeDefinition | undefined {
	return jobTypes.get(id);
}

/** All registered types, in registration order (the picker's display order). */
export function listJobTypes(): JobTypeDefinition[] {
	return [...jobTypes.values()];
}
