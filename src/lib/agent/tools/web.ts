import { invoke } from '@tauri-apps/api/core';
import { chatCompletion, type ChatMessage } from '$lib/api';
import { detectPaywall } from '$lib/agent/paywall';
import { getSettings, getSamplingParams, getChatTemplateKwargs } from '$lib/stores/settings';
import { registerTool } from './registry';
import { toolResult, toolError } from './types';

const RESEARCH_AGENT_MAX_TOKENS = 3072;

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

interface ImageSearchResult {
	title: string;
	url: string;
	thumb_url: string;
	width: number;
	height: number;
	mime: string;
	license: string;
	attribution: string;
	description_url: string;
}

interface PageImage {
	src: string;
	alt: string;
	width: number | null;
	height: number | null;
}

function paywallErrorMessage(url: string, reason: string): string {
	return (
		`Paywalled: ${url} — ${reason}. Do NOT cite any facts from this URL; ` +
		`whatever text you might see would be a teaser or login gate, not the ` +
		`real article. Search for an alternative source that is freely readable.`
	);
}

// --- Registration ---

registerTool({
	category: 'web',
	schema: {
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
	displayLabel: (args) => (args.query as string) || '',
	async execute(args, ctx) {
		const query = args.query as string;
		try {
			const settings = getSettings();
			const results = await invoke<SearchResult[]>('proxy_search', {
				query,
				provider: settings.searchProvider,
				apiKey: settings.braveApiKey || null,
				instanceUrl: settings.searxngUrl || null,
				recency: settings.searchRecency || null,
				deepResearch: ctx.deepResearch,
				proxy: settings.proxy
			});
			return toolResult(JSON.stringify(results));
		} catch (e) {
			return toolResult(toolError(`Search failed: ${e}`));
		}
	}
});

registerTool({
	category: 'web',
	schema: {
		type: 'function',
		function: {
			name: 'fetch_url',
			description:
				'Fetch and extract the raw text content from a web page URL. Use this when you need to see the full page text yourself — for example, structured data, code samples, or content where you cannot describe in advance what is relevant. For research questions where you only need the parts of a page that answer a specific question, prefer research_url instead — it is much cheaper on context.',
			parameters: {
				type: 'object',
				properties: {
					url: { type: 'string', description: 'The URL to fetch' }
				},
				required: ['url']
			}
		}
	},
	displayLabel: (args) => (args.url as string) || '',
	async execute(args) {
		const url = args.url as string;
		try {
			const content = await invoke<string>('proxy_fetch', {
				url,
				caller: 'fetch_url',
				proxy: getSettings().proxy
			});
			const paywall = detectPaywall(url, content);
			if (paywall.paywalled) {
				return toolResult(paywallErrorMessage(url, paywall.reason || 'page is paywalled'));
			}
			return toolResult(content);
		} catch (e) {
			return toolResult(`Failed to fetch URL: ${e}`);
		}
	}
});

registerTool({
	category: 'web',
	schema: {
		type: 'function',
		function: {
			name: 'research_url',
			description:
				'Read a web page through a focused research assistant that extracts only the information relevant to a specific question. Returns concise findings instead of the full page text. Preferred over fetch_url when researching across multiple sources — dramatically reduces context usage per page.',
			parameters: {
				type: 'object',
				properties: {
					url: { type: 'string', description: 'The URL to research' },
					focus: {
						type: 'string',
						description:
							'What information to look for on this page. Be specific — this is the question the research assistant will try to answer using only this single page.'
					}
				},
				required: ['url', 'focus']
			}
		}
	},
	displayLabel: (args) => {
		const url = (args.url as string) || '';
		const focus = (args.focus as string) || '';
		return focus ? `${url} — ${focus}` : url;
	},
	async execute(args, ctx) {
		const url = args.url as string;
		const focus = args.focus as string;

		let pageContent: string;
		try {
			pageContent = await invoke<string>('proxy_fetch', {
				url,
				caller: 'research_url',
				proxy: getSettings().proxy
			});
		} catch (e) {
			return toolResult(`Failed to fetch URL: ${e}`);
		}
		if (!pageContent || pageContent.startsWith('Failed to fetch')) {
			return toolResult(pageContent || `Failed to fetch URL: ${url}`);
		}

		const paywall = detectPaywall(url, pageContent);
		if (paywall.paywalled) {
			return toolResult(paywallErrorMessage(url, paywall.reason || 'page is paywalled'));
		}

		const systemPrompt =
			'You are a focused research assistant. You will be given the text of a single web page and a specific focus question. Your job is to extract from the page only the information that is relevant to the focus question, and return it as concise findings.\n\n' +
			'Rules:\n' +
			'- Quote specific facts, numbers, names, and dates verbatim from the page.\n' +
			'- Use bullet points organized by sub-topic when helpful.\n' +
			'- Do not summarize parts of the page that are not relevant to the focus.\n' +
			'- Do not invent or extrapolate — every claim must be supported by the page text.\n' +
			'- If the page contains no information relevant to the focus, reply with exactly: "No relevant information found on this page."\n' +
			'- Do not add preamble, meta-commentary, or closing remarks. Output only the findings.';

		const userPrompt =
			`Focus: ${focus}\n\n` +
			`Page URL: ${url}\n\n` +
			`Page content:\n${pageContent}\n\n` +
			`Extract from the page above only the information relevant to the focus.`;

		const messages: ChatMessage[] = [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: userPrompt }
		];

		try {
			const sampling = getSamplingParams();
			const response = await chatCompletion(
				{
					messages,
					temperature: sampling.temperature,
					top_p: sampling.top_p,
					max_tokens: RESEARCH_AGENT_MAX_TOKENS,
					chat_template_kwargs: getChatTemplateKwargs()
				},
				ctx.signal
			);
			const findings = response.content?.trim();
			if (!findings) {
				return toolResult(`Sub-agent returned no findings for ${url}.`);
			}
			return toolResult(`Source: ${url}\nFocus: ${focus}\n\n${findings}`);
		} catch (e) {
			if (e instanceof DOMException && e.name === 'AbortError') throw e;
			return toolResult(`Research sub-agent failed for ${url}: ${e}`);
		}
	}
});

registerTool({
	category: 'web',
	schema: {
		type: 'function',
		function: {
			name: 'image_search',
			description:
				'Search Wikimedia Commons for freely-licensed images. Returns image metadata including url, thumbnail, dimensions, and license. All results are openly licensed — safe to embed in documents or presentations.',
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description:
							'What to search for. Plain English works ("Eiffel Tower at night", "red panda", "vintage motorcycle").'
					},
					max_results: {
						type: 'integer',
						minimum: 1,
						maximum: 20,
						description: 'How many results to return. Defaults to 5. Cap is 20.'
					}
				},
				required: ['query']
			}
		}
	},
	displayLabel: (args) => (args.query as string) || '',
	async execute(args) {
		const query = args.query as string;
		const maxResults = args.max_results as number | undefined;
		try {
			const results = await invoke<ImageSearchResult[]>('proxy_image_search', {
				query,
				maxResults: maxResults ?? null,
				proxy: getSettings().proxy
			});
			if (results.length === 0) {
				return toolResult(
					JSON.stringify({
						results: [],
						note: `No Wikimedia Commons images found for "${query}". Try a broader or different query.`
					})
				);
			}
			return toolResult(JSON.stringify({ results }));
		} catch (e) {
			return toolResult(toolError(`image_search failed: ${e}`));
		}
	}
});

registerTool({
	category: 'web',
	schema: {
		type: 'function',
		function: {
			name: 'fetch_url_images',
			description:
				'Fetch a web page and return a list of image URLs found on it (img tags, og:image, etc.). Returns up to 50 results as { src, alt, width?, height? } objects. Use this to find images on a specific page, e.g. product photos from a manufacturer site.',
			parameters: {
				type: 'object',
				properties: {
					url: {
						type: 'string',
						description: 'The URL of the page to scan for images.'
					}
				},
				required: ['url']
			}
		}
	},
	displayLabel: (args) => (args.url as string) || '',
	async execute(args) {
		const url = args.url as string;
		try {
			const images = await invoke<PageImage[]>('proxy_fetch_url_images', {
				url,
				proxy: getSettings().proxy
			});
			if (images.length === 0) {
				return toolResult(
					JSON.stringify({
						images: [],
						note: `No images found on ${url}. The page may be client-rendered or blocked.`
					})
				);
			}
			return toolResult(JSON.stringify({ images }));
		} catch (e) {
			return toolResult(toolError(`fetch_url_images failed: ${e}`));
		}
	}
});
