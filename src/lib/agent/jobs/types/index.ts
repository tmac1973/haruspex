/**
 * Job-type registration barrel: importing this module registers every
 * built-in job type (module caching makes it idempotent). Import THIS —
 * not ./registry — from anything that consults the registry, so lookups
 * never race registration. Registration order is the picker display order.
 */

import { registerJobType } from '#lib/agent/jobs/types/registry.ts';
import { researchJobType } from '#lib/agent/jobs/types/research/definition.ts';
import { emailDigestJobType } from '#lib/agent/jobs/types/email-digest/definition.ts';
import { newsDigestJobType } from '#lib/agent/jobs/types/news-digest/definition.ts';
import { auditJobType } from '#lib/agent/jobs/types/audit/definition.ts';
import { guidedPlanningJobType } from '#lib/agent/jobs/types/guided-planning/definition.ts';
import { autonomousCodingJobType } from '#lib/agent/jobs/types/autonomous-coding/definition.ts';
import { assetGenerationJobType } from '#lib/agent/jobs/types/asset-generation/definition.ts';
import { modelGenerationJobType } from '#lib/agent/jobs/types/model-generation/definition.ts';

registerJobType(researchJobType);
registerJobType(emailDigestJobType);
registerJobType(newsDigestJobType);
registerJobType(auditJobType);
registerJobType(guidedPlanningJobType);
registerJobType(autonomousCodingJobType);
registerJobType(assetGenerationJobType);
registerJobType(modelGenerationJobType);

export { getJobType, listJobTypes } from '#lib/agent/jobs/types/registry.ts';
export {
	ensureTypeAvailabilityLoaded,
	isJobTypeAvailable
} from '#lib/agent/jobs/types/availability.svelte.ts';
export type { JobTypeDefinition, JobRunContext, PlannedStep } from '#lib/agent/jobs/types/types.ts';
