/**
 * Job-type registration barrel: importing this module registers every
 * built-in job type (module caching makes it idempotent). Import THIS —
 * not ./registry — from anything that consults the registry, so lookups
 * never race registration. Registration order is the picker display order.
 *
 * Registered so far: research (Phase 02 pilot). Audit and guided planning
 * convert in Phase 03; autonomous coding lands in Phase 05.
 */

import { registerJobType } from './registry';
import { researchJobType } from './research/definition';

registerJobType(researchJobType);

export { getJobType, listJobTypes } from './registry';
export type { JobTypeDefinition, JobRunContext, PlannedStep } from './types';
