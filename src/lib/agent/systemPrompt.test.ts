import { describe, it, expect, vi, afterEach } from 'vitest';

const settingsMock = vi.hoisted(() => ({ agentFeedbackEnabled: false }));

vi.mock('#lib/stores/settings.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/stores/settings.ts')>()),
	getSettings: () => ({
		customSystemPrompt: '',
		sandboxEnabled: false,
		agentFeedbackEnabled: settingsMock.agentFeedbackEnabled
	}),
	getResponseFormatPrompt: () => '',
	getIncludeImagesPrompt: () => '\n\nIMAGES:\n- When the answer is about something visual',
	hasEnabledEmailAccount: () => false,
	hasEnabledCalendarAccount: () => false,
	hasEnabledContactsAccount: () => false,
	// registry.ts reads this through the mcp-names predicate when filtering
	// schemas; the tool-description assertion below goes through getToolSchemas.
	startableMcpServers: () => [
		{
			id: 'sp-srv-1',
			label: 'GitHub',
			enabled: true,
			source: { kind: 'catalog', entryId: 'github' },
			secrets: {},
			toolEnabled: {},
			proxyUse: 'auto',
			setupComplete: true
		}
	]
}));

import { buildSystemPrompt, injectMessageHints } from './systemPrompt';
import { renderSlashMessage } from '#lib/skills/content.ts';
import { registerMcpTools, unregisterMcpServer } from '#lib/agent/tools/mcp.ts';
import { getToolSchemas } from '#lib/agent/tools/registry.ts';
import type { McpToolDescriptor } from '#lib/ipc/gen/McpToolDescriptor.ts';
import type { ChatMessage } from '#lib/api.ts';

/**
 * Memory is a PARAMETER, not something this module fetches. Job runs, remote
 * guests and the shell assistant all build their prompts through here, and
 * the plan's "chat only" scope is enforced by that signature — a caller that
 * does not pass memories cannot receive them by accident.
 *
 * It rides the latest user message rather than the system prompt. Recall
 * changes from turn to turn, and llama-server reuses its cache only up to the
 * first token that differs: memory in the system message made a seven-turn
 * chat cost 20,957 prompt tokens instead of 83 on Qwen 3.5 9B.
 */
describe('injectMessageHints — memory section', () => {
	const section = '\n\nMEMORY — things you learned:\n- Prefers tabs.';
	const last = (messages: ChatMessage[]): string => String(messages.at(-1)?.content);
	const history: ChatMessage[] = [
		{ role: 'user', content: 'first question' },
		{ role: 'assistant', content: 'first answer' },
		{ role: 'user', content: 'second question' }
	];

	it('adds nothing when no memories are passed', () => {
		const out = injectMessageHints(history, { workingDir: null, exhaustiveResearch: false });
		expect(out).toBe(history);
	});

	it('adds nothing for a caller that passes an empty section', () => {
		const out = injectMessageHints(history, {
			workingDir: null,
			exhaustiveResearch: false,
			memorySection: ''
		});
		expect(out).toBe(history);
	});

	it('appends the section to the latest user message only', () => {
		const out = injectMessageHints(history, {
			workingDir: null,
			exhaustiveResearch: false,
			memorySection: section
		});
		expect(last(out)).toBe('second question' + section);
		expect(out.slice(0, -1)).toEqual(history.slice(0, -1));
		// A copy: the stored conversation never keeps a turn's memories.
		expect(history.at(-1)?.content).toBe('second question');
	});

	it('puts memory after the hints, so it stays the freshest context', () => {
		const out = injectMessageHints([{ role: 'user', content: 'best budget headphones?' }], {
			workingDir: null,
			exhaustiveResearch: false,
			memorySection: section
		});
		expect(last(out)).toContain('Include Reddit as a source.');
		expect(last(out).endsWith('- Prefers tabs.')).toBe(true);
	});

	it('reaches the text part of a message with an image', () => {
		const out = injectMessageHints(
			[
				{
					role: 'user',
					content: [
						{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
						{ type: 'text', text: 'what is this?' }
					]
				}
			],
			{ workingDir: null, exhaustiveResearch: false, memorySection: section }
		);
		expect(out.at(-1)?.content).toContainEqual({ type: 'text', text: 'what is this?' + section });
	});

	it('never puts memory in the system prompt', () => {
		expect(buildSystemPrompt(null).content as string).not.toContain('MEMORY');
	});

	it('leaves the system message the same when recalled memories change', () => {
		const turn = (memorySection: string): ChatMessage[] => {
			const messages = [buildSystemPrompt(null), ...history];
			return injectMessageHints(messages, {
				workingDir: null,
				exhaustiveResearch: false,
				memorySection
			});
		};
		const a = turn('\n\nMEMORY — things you learned:\n- Has a dog named Biscuit.');
		const b = turn('\n\nMEMORY — things you learned:\n- Prefers metric units.');
		const none = turn('');
		// Everything up to the latest user message is a stable prefix.
		expect(b.slice(0, -1)).toEqual(a.slice(0, -1));
		expect(none.slice(0, -1)).toEqual(a.slice(0, -1));
		expect(last(a)).not.toBe(last(b));
	});
});

/**
 * The prompt used to give two different answers to "when should I search?":
 * a header naming "products, current events, pricing, or recommendations",
 * and a rule below saying "factual questions". Those contradict, and a model
 * asked "tell me about monkeys" could satisfy the narrower one by not
 * searching at all — observed 1 run in 3 on Qwen 3.6 35B.
 */
describe('buildSystemPrompt — search rules', () => {
	const prompt = () => buildSystemPrompt(null).content as string;

	it('states when to search once, not twice with different scopes', () => {
		const p = prompt();
		// The narrow list was the half the model could hide behind.
		expect(p).not.toContain('products, current events, pricing, or recommendations');
	});

	it('names the shape of question that was being skipped', () => {
		expect(prompt()).toContain('"Tell me about X"');
	});

	it('still says what NOT to search for', () => {
		// Without this half the rule reads as "always search", which would put
		// a web search in front of arithmetic and creative writing.
		const p = prompt();
		expect(p).toContain('Do NOT search');
		expect(p).toMatch(/arithmetic/);
		expect(p).toMatch(/creative writing/);
		expect(p).toMatch(/a picture to draw/);
	});

	it('keeps the fetch and citation rules that follow it', () => {
		const p = prompt();
		expect(p).toContain('Use fetch_url on 2-4 of the most relevant results');
		expect(p).toContain('Only cite sources you actually fetched');
		expect(p).toContain('include Reddit alongside review sites');
	});
});

/**
 * Images are a PARAMETER for the same reason memories are. The IMAGES block
 * must reach the Chat tab and nothing else — a job run, a remote guest and the
 * shell assistant all build their prompts through this function.
 */
describe('buildSystemPrompt — images section', () => {
	it('omits the block when the caller does not ask for it', () => {
		const prompt = buildSystemPrompt(null).content as string;
		expect(prompt).not.toContain('IMAGES:');
	});

	it('omits it when the caller explicitly opts out', () => {
		const prompt = buildSystemPrompt(null, { includeImages: false }).content as string;
		expect(prompt).not.toContain('IMAGES:');
	});

	it('adds it when the caller opts in', () => {
		const prompt = buildSystemPrompt(null, { includeImages: true }).content as string;
		expect(prompt).toContain('IMAGES:');
	});

	/**
	 * The regression that matters most to users who never turn this on: with
	 * the setting off, the prompt must be byte-identical to what it was before
	 * the feature existed.
	 */
	it('leaves the prompt byte-identical when images are off', () => {
		const off = buildSystemPrompt(null, { includeImages: false }).content as string;
		const unset = buildSystemPrompt(null).content as string;
		expect(off).toBe(unset);
	});
});

describe('buildSystemPrompt — connected integrations', () => {
	const SERVER = 'sp-srv-1';

	function tool(name: string): McpToolDescriptor {
		return {
			name,
			title: null,
			description: `does ${name}`,
			inputSchema: { type: 'object' },
			annotations: null
		};
	}

	afterEach(() => unregisterMcpServer(SERVER));

	it('says nothing when nothing is connected', () => {
		const prompt = buildSystemPrompt(null).content as string;
		expect(prompt).not.toContain('CONNECTED INTEGRATIONS');
	});

	it('names the connected services rather than gesturing at integrations', () => {
		// A general "prefer integrations" loses to a concrete run_python the
		// model already knows how to write. Naming GitHub gives it something to
		// reach for.
		registerMcpTools(SERVER, 'GitHub', [tool('list_pull_requests')], ['list_pull_requests']);
		const prompt = buildSystemPrompt(null).content as string;
		expect(prompt).toContain('CONNECTED INTEGRATIONS: GitHub');
	});

	it('tells the model not to reach for Python or the raw API instead', () => {
		// The observed failure: asked about recent PRs, the model tried the
		// Python sandbox, then the GitHub API by hand, then scraped the web page
		// — and only used the MCP server when told to.
		registerMcpTools(SERVER, 'GitHub', [tool('list_pull_requests')], ['list_pull_requests']);
		const prompt = buildSystemPrompt(null).content as string;
		expect(prompt).toMatch(/Do NOT write Python/i);
		expect(prompt).toMatch(/fetch its web pages/i);
	});

	it('lists only servers whose tools the model can actually see', () => {
		// A configured server that failed to start has no tools; naming it would
		// send the model looking for something that is not there.
		const prompt = buildSystemPrompt(null).content as string;
		expect(prompt).not.toContain('GitHub');
	});

	it('names each server once however many tools it has', () => {
		registerMcpTools(SERVER, 'GitHub', [tool('a'), tool('b'), tool('c')], ['a', 'b', 'c']);
		const prompt = buildSystemPrompt(null).content as string;
		expect(prompt.match(/GitHub/g)?.length).toBe(1);
	});

	it('carries the server label into every tool description', () => {
		// The registered name carries a server *id*, so without this the model
		// has no way to tell which of its tools belong to GitHub.
		registerMcpTools(SERVER, 'GitHub', [tool('list_pull_requests')], ['list_pull_requests']);
		const schema = getToolSchemas({ hasWorkingDir: false }).find((s) =>
			s.function.name.endsWith('__list_pull_requests')
		);
		expect(schema?.function.description).toContain('(via GitHub)');
	});
});

describe('buildSystemPrompt — skills section', () => {
	it('appears only when the caller passes one', () => {
		expect(buildSystemPrompt(null).content as string).not.toContain('SKILLS:');
		const prompt = buildSystemPrompt(null, { skillsSection: '\n\nSKILLS:\n- deploy: Ship it.' })
			.content as string;
		expect(prompt).toContain('- deploy: Ship it.');
	});
});

describe('buildSystemPrompt — the user guide', () => {
	const text = (opts?: Parameters<typeof buildSystemPrompt>[1]) =>
		String(buildSystemPrompt(null, opts).content);

	it('points Chat and remote guests at haruspex_docs, and nobody else', () => {
		expect(text({ guide: true })).toContain('call haruspex_docs');
		// A job builds its prompt here too, and is never offered the tool.
		expect(text()).not.toContain('haruspex_docs');
	});
});

describe('buildSystemPrompt — model feedback on tools', () => {
	const text = (opts?: Parameters<typeof buildSystemPrompt>[1]) =>
		String(buildSystemPrompt(null, opts).content);

	it('asks Chat for reports only while Settings → Feedback has them on', () => {
		settingsMock.agentFeedbackEnabled = true;
		expect(text({ feedback: true })).toContain('call haruspex_feedback');
		// A job or a remote guest builds its prompt here without the flag.
		expect(text()).not.toContain('haruspex_feedback');
		settingsMock.agentFeedbackEnabled = false;
		expect(text({ feedback: true })).not.toContain('haruspex_feedback');
	});
});

describe('injectMessageHints', () => {
	const hinted = (content: string, exhaustiveResearch = false): string =>
		String(
			injectMessageHints([{ role: 'user', content }], { workingDir: null, exhaustiveResearch }).at(
				-1
			)?.content
		);
	const weather = renderSlashMessage(
		{
			name: 'weather',
			body: 'Note the warmest day and any records. Takes the best geocoder match.',
			dir: null,
			compatibility: null,
			files: [],
			filesTruncated: false,
			needs: [],
			buildsOn: null
		},
		'/weather Chicago'
	);

	it('asks for Reddit on a review question, and for depth with deep research on', () => {
		expect(hinted('best budget headphones?')).toContain('Include Reddit as a source.');
		expect(hinted('tell me about monkeys', true)).toContain('Research this thoroughly.');
	});

	it('leaves a skill run alone, whatever words the skill uses', () => {
		expect(hinted(weather)).toBe(weather);
		expect(hinted(weather, true)).toBe(weather);
	});
});
