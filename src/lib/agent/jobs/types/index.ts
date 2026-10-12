/**
 * Job-type registration barrel: importing this module registers every
 * built-in job type (module caching makes it idempotent). Import THIS —
 * not ./registry — from anything that consults the registry, so lookups
 * never race registration. Registration order is the picker display order.
 */

import { registerJobType } from '#lib/agent/jobs/types/registry.ts';
import { researchJobType } from '#lib/agent/jobs/types/research/definition.ts';
import { auditJobType } from '#lib/agent/jobs/types/audit/definition.ts';
import { guidedPlanningJobType } from '#lib/agent/jobs/types/guided-planning/definition.ts';
import { autonomousCodingJobType } from '#lib/agent/jobs/types/autonomous-coding/definition.ts';
import { assetGenerationJobType } from '#lib/agent/jobs/types/asset-generation/definition.ts';

registerJobType(researchJobType);
registerJobType(auditJobType);
registerJobType(guidedPlanningJobType);
registerJobType(autonomousCodingJobType);
registerJobType(assetGenerationJobType);

export { getJobType, listJobTypes } from '#lib/agent/jobs/types/registry.ts';
export {
	ensureTypeAvailabilityLoaded,
	isJobTypeAvailable
} from '#lib/agent/jobs/types/availability.svelte.ts';
export type { JobTypeDefinition, JobRunContext, PlannedStep } from '#lib/agent/jobs/types/types.ts';
