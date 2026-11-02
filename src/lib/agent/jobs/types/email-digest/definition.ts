import type { JobTypeDefinition, JobValidateInput } from '#lib/agent/jobs/types/types.ts';
import Editor from '#lib/agent/jobs/types/email-digest/Editor.svelte';
import {
	DEFAULT_MAX,
	emailDigestDefaults,
	parseEmailDigestConfig,
	type EmailDigestConfig
} from '#lib/agent/jobs/types/email-digest/config.ts';
import {
	planEmailDigestSteps,
	resultSchema,
	runEmailDigestPipeline
} from '#lib/agent/jobs/types/email-digest/pipeline.ts';

function missing({ config }: JobValidateInput): string[] {
	const c = config as unknown as EmailDigestConfig;
	const out: string[] = [];
	if (c.accountIds.length === 0) out.push('Email account');
	if (!c.rule.trim()) out.push('Rule');
	return out;
}

export const emailDigestJobType: JobTypeDefinition = {
	id: 'email_digest',
	label: 'Email digest',
	description:
		'Picks the important messages from your unread email by a rule you write. Home’s Important emails card runs one.',
	badgeLabel: 'email',
	hasPlannedSteps: false,
	supportsSchedule: true,
	background: true,
	resultSchema: resultSchema(DEFAULT_MAX),
	Editor,
	configDefaults: () => ({ ...emailDigestDefaults() }),
	configFromJob: (typeConfig) => ({ ...parseEmailDigestConfig(typeConfig) }),
	configToJson: (config) => {
		const c = config as unknown as EmailDigestConfig;
		return JSON.stringify({
			accountIds: c.accountIds,
			rule: c.rule.trim(),
			hours: c.hours,
			max: c.max
		});
	},
	validate: (input) => {
		const c = input.config as unknown as EmailDigestConfig;
		if (c.accountIds.length === 0) return 'Choose an email account.';
		if (!c.rule.trim()) return 'Say what counts as important.';
		if (!(c.hours >= 1 && c.hours <= 168)) return 'Look back between 1 and 168 hours.';
		if (!(c.max >= 1 && c.max <= 20)) return 'Show between 1 and 20 messages.';
		return null;
	},
	missingRequired: missing,
	persistSteps: () => [],
	planSteps: planEmailDigestSteps,
	runPipeline: runEmailDigestPipeline
};
