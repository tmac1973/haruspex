import type { JobTypeDefinition, JobValidateInput } from '#lib/agent/jobs/types/types.ts';
import Editor from '#lib/agent/jobs/types/news-digest/Editor.svelte';
import {
	DEFAULT_MAX,
	newsDigestDefaults,
	parseNewsDigestConfig,
	type NewsDigestConfig
} from '#lib/agent/jobs/types/news-digest/config.ts';
import {
	planNewsDigestSteps,
	resultSchema,
	runNewsDigestPipeline
} from '#lib/agent/jobs/types/news-digest/pipeline.ts';

function missing({ config }: JobValidateInput): string[] {
	const c = config as unknown as NewsDigestConfig;
	const out: string[] = [];
	if (c.feeds.length === 0) out.push('Feed');
	if (!c.interests.trim()) out.push('Interests');
	return out;
}

export const newsDigestJobType: JobTypeDefinition = {
	id: 'news_digest',
	label: 'News digest',
	description:
		'Picks the stories that match your interests from RSS and Atom feeds. Home’s News card runs one.',
	badgeLabel: 'news',
	hasPlannedSteps: false,
	supportsSchedule: true,
	background: true,
	resultSchema: resultSchema(DEFAULT_MAX),
	Editor,
	configDefaults: () => ({ ...newsDigestDefaults() }),
	configFromJob: (typeConfig) => ({ ...parseNewsDigestConfig(typeConfig) }),
	configToJson: (config) => {
		const c = config as unknown as NewsDigestConfig;
		return JSON.stringify({
			feeds: c.feeds,
			interests: c.interests.trim(),
			hours: c.hours,
			max: c.max
		});
	},
	validate: (input) => {
		const c = input.config as unknown as NewsDigestConfig;
		if (c.feeds.length === 0) return 'Add at least one feed.';
		if (!c.interests.trim()) return 'Say what news you want.';
		if (!(c.hours >= 1 && c.hours <= 168)) return 'Look back between 1 and 168 hours.';
		if (!(c.max >= 1 && c.max <= 20)) return 'Show between 1 and 20 stories.';
		return null;
	},
	missingRequired: missing,
	persistSteps: () => [],
	planSteps: planNewsDigestSteps,
	runPipeline: runNewsDigestPipeline
};
