import type { JobTypeDefinition, JobValidateInput } from '#lib/agent/jobs/types/types.ts';
import Editor from '#lib/agent/jobs/types/email-research/Editor.svelte';
import { getSettings } from '#lib/stores/settings.ts';
import {
	emailResearchConfigJson,
	emailResearchDefaults,
	emailResearchProblem,
	parseEmailResearchConfig,
	type EmailResearchConfig
} from '#lib/agent/jobs/types/email-research/config.ts';
import { accountTakenBy } from '#lib/agent/jobs/types/email-research/accountJobs.svelte.ts';
import {
	planEmailResearchSteps,
	resultSchema,
	runEmailResearchPipeline
} from '#lib/agent/jobs/types/email-research/pipeline.ts';

function canSend(accountId: string): boolean {
	const account = getSettings().integrations.email.accounts.find((a) => a.id === accountId);
	return !!account && account.sendEnabled;
}

function missing({ config }: JobValidateInput): string[] {
	const c = config as unknown as EmailResearchConfig;
	const out: string[] = [];
	if (!c.accountId || !canSend(c.accountId)) out.push('Email account');
	if (!c.phrase.trim()) out.push('Trigger phrase');
	return out;
}

export const emailResearchJobType: JobTypeDefinition = {
	id: 'email_research',
	label: 'Research by email',
	description:
		'Answers research questions you email to yourself, with web tools only, and replies in the thread.',
	badgeLabel: 'email',
	hasPlannedSteps: false,
	supportsSchedule: true,
	background: true,
	resultSchema,
	Editor,
	configDefaults: () => ({ ...emailResearchDefaults() }),
	configFromJob: (typeConfig) => ({ ...parseEmailResearchConfig(typeConfig) }),
	configToJson: (config) => emailResearchConfigJson(config as unknown as EmailResearchConfig),
	validate: (input) =>
		emailResearchProblem(input.config as unknown as EmailResearchConfig, {
			jobId: input.jobId,
			workingDir: input.workingDir,
			accountTakenBy: (id, except) => accountTakenBy(id, except),
			canSend
		}),
	missingRequired: missing,
	persistSteps: () => [],
	planSteps: planEmailResearchSteps,
	runPipeline: runEmailResearchPipeline
};
