/**
 * Cards that own a job: a judged card (important emails, news) is a job of
 * its card type's `jobType`, made when the card is added and shown in the
 * Jobs tab with a "Home" badge, where the user can edit its schedule.
 */
import { getCardType } from '#lib/home/cardTypes.ts';
import { getJobType } from '#lib/agent/jobs/types/index.ts';
import { createJob, scheduleToConfigJson, type Schedule } from '#lib/stores/jobs.svelte.ts';
import { addCard, getHomeCards } from '#lib/stores/homeCards.svelte.ts';
import type { HomeCard } from '#lib/ipc/gen/HomeCard.ts';

/**
 * Make a card type's job from the Add card form's settings and add its card.
 * The job is due now, so the card fills in at once. Null when either write
 * failed (a job with no card is left in the Jobs tab, where it can be deleted).
 */
export async function createCardJob(
	cardTypeId: string,
	typeConfig: Record<string, unknown>,
	schedule: Schedule
): Promise<HomeCard | null> {
	const cardType = getCardType(cardTypeId);
	const jobType = cardType?.jobType ? getJobType(cardType.jobType) : undefined;
	if (!cardType || !jobType) return null;
	const jobId = await createJob({
		name: cardType.label,
		description: null,
		working_dir: '',
		auto_approve_tools: false,
		job_type: jobType.id,
		schedule_kind: schedule.kind,
		schedule_config: scheduleToConfigJson(schedule),
		next_due_at: Date.now(),
		type_config: jobType.configToJson({ ...jobType.configDefaults(), ...typeConfig }),
		model_remote_base_url: null,
		model_remote_api_key: null,
		model_remote_api_key_id: null,
		model_remote_model_id: null,
		model_remote_context_size: null,
		model_remote_vision_supported: null,
		model_advanced: null
	});
	if (jobId === null) return null;
	return addCard(cardTypeId, {}, jobId, cardType.defaultSize);
}

/** Whether a card's job belongs to it, rather than being a job the user pinned. */
export function ownsJob(card: HomeCard): boolean {
	return card.job_id !== null && getCardType(card.card_type)?.jobType !== undefined;
}

/** The jobs that belong to a Home card, for the Jobs tab's "Home" badge. */
export function ownedJobIds(): Set<number> {
	return new Set(
		getHomeCards()
			.filter(ownsJob)
			.map((c) => c.job_id as number)
	);
}
