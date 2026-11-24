import type { JobTypeDefinition } from '#lib/agent/jobs/types/types.ts';
import Editor from '#lib/agent/jobs/types/notebook-refresh/Editor.svelte';
import {
	notebookRefreshConfigToJson,
	notebookRefreshDefaults,
	parseNotebookRefreshConfig,
	validateNotebookRefresh,
	type NotebookRefreshConfig
} from '#lib/agent/jobs/types/notebook-refresh/config.ts';
import {
	planNotebookRefreshSteps,
	runNotebookRefreshPipeline
} from '#lib/agent/jobs/types/notebook-refresh/pipeline.ts';
import { getNotebookList } from '#lib/stores/notebooks.svelte.ts';
import { getSettings } from '#lib/stores/settings.ts';

export const notebookRefreshJobType: JobTypeDefinition = {
	id: 'notebook_refresh',
	label: 'Refresh notebook',
	description: 'Re-runs your instruction against a notebook on a schedule.',
	badgeLabel: 'notebook',
	hasPlannedSteps: false,
	supportsSchedule: true,
	background: true,
	available: async () => getSettings().notebooksTab && !getSettings().leanMode,
	Editor,
	configDefaults: () => ({ ...notebookRefreshDefaults() }),
	configFromJob: (typeConfig) => ({ ...parseNotebookRefreshConfig(typeConfig) }),
	configToJson: (config) => notebookRefreshConfigToJson(config as unknown as NotebookRefreshConfig),
	validate: (input) =>
		validateNotebookRefresh(input.config as unknown as NotebookRefreshConfig, (id) =>
			getNotebookList().some((n) => n.id === id)
		),
	missingRequired: ({ config }) => {
		const c = config as unknown as NotebookRefreshConfig;
		return [
			...(c.notebookId ? [] : ['Notebook']),
			...(c.instruction?.trim() ? [] : ['What to update'])
		];
	},
	persistSteps: () => [],
	planSteps: planNotebookRefreshSteps,
	runPipeline: runNotebookRefreshPipeline
};
