/** The Search helper: `search_code` (`#lib/agent/tools/search-code.ts`). */
import { registerHelper } from '#lib/helpers/registry.ts';
import { parseSearchConfig } from '#lib/helpers/search/config.ts';

registerHelper({
	id: 'search',
	label: 'Search',
	summary: 'Finds code from a question in plain words.',
	tooltip:
		"Scores the project's files by the words in the question and shows the agent the six best snippets with their paths and lines. Optionally reranks them with a server you run.",
	tools: ['search_code'],
	writes: false,
	settings: {
		parse: parseSearchConfig,
		component: () => import('#lib/helpers/search/SearchSettings.svelte')
	}
});
