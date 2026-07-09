/**
 * Job-type registration barrel: importing this module registers every
 * built-in job type (module caching makes it idempotent). Import THIS —
 * not ./registry — from anything that consults the registry, so lookups
 * never race registration. Registration order is the picker display order.
 */

import { registerJobType } from './registry';
import { researchJobType } from './research/definition';
import { auditJobType } from './audit/definition';
import { guidedPlanningJobType } from './guided-planning/definition';
import { autonomousCodingJobType } from './autonomous-coding/definition';

registerJobType(researchJobType);
registerJobType(auditJobType);
registerJobType(guidedPlanningJobType);
registerJobType(autonomousCodingJobType);

export { getJobType, listJobTypes } from './registry';
export { ensureTypeAvailabilityLoaded, isJobTypeAvailable } from './availability.svelte';
export type { JobTypeDefinition, JobRunContext, PlannedStep } from './types';
