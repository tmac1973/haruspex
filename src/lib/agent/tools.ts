import type { ToolDefinition } from '$lib/api';

export const AGENT_TOOLS: ToolDefinition[] = [
	{
		type: 'function',
		function: {
			name: 'web_search',
			description:
				'Search the web for current information. Use this when the user asks about recent events, facts you are unsure about, or anything that benefits from up-to-date information.',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'The search query' }
				},
				required: ['query']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'fetch_url',
			description:
				'Fetch and extract the text content from a web page URL. Use this to read full articles or pages found via web_search.',
			parameters: {
				type: 'object',
				properties: {
					url: { type: 'string', description: 'The URL to fetch' }
				},
				required: ['url']
			}
		}
	}
];
