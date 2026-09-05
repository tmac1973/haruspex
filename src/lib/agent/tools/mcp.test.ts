import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { McpToolDescriptor } from '$lib/ipc/gen/McpToolDescriptor';
import type { McpCallOutcome } from '$lib/ipc/gen/McpCallOutcome';
import type { McpServerConfig } from '$lib/ipc/gen/McpServerConfig';
import { setMcpServers } from '$lib/stores/settings';
import { mcpToolName, parseMcpToolName } from './mcp-names';
import {
	registerMcpTools,
	unregisterMcpServer,
	registeredMcpToolNames,
	MAX_MRTR_ROUNDS,
	elicitationMessage,
	formatContent,
	setToolFailureHook
} from './mcp';
import { getToolSchemas, executeTool } from './registry';
import {
	forgetAllApprovals,
	forgetServerApprovals,
	getPendingMcpApproval,
	isAlwaysAllowed,
	requiresApproval,
	resolveMcpApproval,
	type McpApprovalChoice
} from '$lib/stores/mcpApproval.svelte';
import type { ToolContext } from './types';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const SERVER = 'srv-1';
const OTHER = 'srv-2';

function tool(name: string, over: Partial<McpToolDescriptor> = {}): McpToolDescriptor {
	return {
		name,
		title: null,
		description: `does ${name}`,
		inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
		annotations: {
			title: null,
			readOnlyHint: true,
			destructiveHint: null,
			idempotentHint: null,
			openWorldHint: null
		},
		...over
	};
}

function server(id: string, over: Partial<McpServerConfig> = {}): McpServerConfig {
	return {
		id,
		label: `Server ${id}`,
		enabled: true,
		source: { kind: 'catalog', entryId: 'x' },
		secrets: {},
		toolEnabled: {},
		setupComplete: true,
		...over
	};
}

function ctx(over: Partial<ToolContext> = {}): ToolContext {
	return {
		workingDir: null,
		pendingImages: [],
		deepResearch: false,
		filesWrittenThisTurn: new Set(),
		shellMode: false,
		codeMode: false,
		codeAutoApprove: false,
		...over
	} as ToolContext;
}

function complete(text: string): McpCallOutcome {
	return {
		type: 'complete',
		content: [{ type: 'text', text }],
		structuredContent: null,
		isError: false
	};
}

/** Answer the approval modal as soon as it appears. */
async function answerApproval(choice: McpApprovalChoice): Promise<void> {
	for (let i = 0; i < 50 && getPendingMcpApproval() === null; i++) {
		await Promise.resolve();
	}
	resolveMcpApproval(choice);
}

beforeEach(() => {
	invoke.mockReset();
	forgetAllApprovals();
	unregisterMcpServer(SERVER);
	unregisterMcpServer(OTHER);
	setMcpServers([server(SERVER), server(OTHER)]);
});

afterEach(() => {
	unregisterMcpServer(SERVER);
	unregisterMcpServer(OTHER);
	setMcpServers([]);
});

describe('MCP tool naming', () => {
	it('round-trips a name through the prefix', () => {
		const name = mcpToolName(SERVER, 'search');
		expect(name).toBe('mcp__srv-1__search');
		expect(parseMcpToolName(name)).toEqual({ serverId: SERVER, toolName: 'search' });
	});

	it('keeps a tool name that contains the separator intact', () => {
		// A server may legitimately call something `read__file`; splitting on
		// every separator would hand the executor a truncated name.
		const name = mcpToolName(SERVER, 'read__file');
		expect(parseMcpToolName(name)).toEqual({ serverId: SERVER, toolName: 'read__file' });
	});

	it('refuses names that are not ours', () => {
		expect(parseMcpToolName('web_search')).toBeNull();
		expect(parseMcpToolName('mcp__')).toBeNull();
		expect(parseMcpToolName('mcp__srv-1__')).toBeNull();
	});
});

describe('dynamic registration', () => {
	it('keeps two servers exposing the same tool name distinct and callable', async () => {
		registerMcpTools(SERVER, 'One', [tool('search')], ['search']);
		registerMcpTools(OTHER, 'Two', [tool('search')], ['search']);

		const names = registeredMcpToolNames();
		expect(names).toEqual(['mcp__srv-1__search', 'mcp__srv-2__search']);

		invoke.mockResolvedValue(complete('from one'));
		await executeTool('mcp__srv-1__search', { q: 'x' }, ctx());
		expect(invoke.mock.calls[0][1]).toMatchObject({ id: SERVER, name: 'search' });

		invoke.mockResolvedValue(complete('from two'));
		await executeTool('mcp__srv-2__search', { q: 'x' }, ctx());
		expect(invoke.mock.calls[1][1]).toMatchObject({ id: OTHER, name: 'search' });
	});

	it('unregisters exactly its own server', () => {
		registerMcpTools(SERVER, 'One', [tool('a'), tool('b')], ['a', 'b']);
		registerMcpTools(OTHER, 'Two', [tool('c')], ['c']);
		unregisterMcpServer(SERVER);
		expect(registeredMcpToolNames()).toEqual(['mcp__srv-2__c']);
	});

	it('replaces a previous registration rather than accumulating', () => {
		// A reconnect that discovers a changed tool list must not leave the old
		// names callable.
		registerMcpTools(SERVER, 'One', [tool('old')], ['old']);
		registerMcpTools(SERVER, 'One', [tool('new')], ['new']);
		expect(registeredMcpToolNames()).toEqual(['mcp__srv-1__new']);
	});

	it('exposes the server schema untouched', () => {
		registerMcpTools(SERVER, 'One', [tool('search')], ['search']);
		const schema = getToolSchemas({ hasWorkingDir: false }).find(
			(s) => s.function.name === 'mcp__srv-1__search'
		);
		expect(schema?.function.parameters).toEqual({
			type: 'object',
			properties: { q: { type: 'string' } }
		});
	});
});

describe('per-tool enablement', () => {
	it('exposes the catalog defaults and hides the rest', () => {
		registerMcpTools(SERVER, 'One', [tool('a'), tool('b')], ['a']);
		const names = getToolSchemas({ hasWorkingDir: false }).map((s) => s.function.name);
		expect(names).toContain('mcp__srv-1__a');
		expect(names).not.toContain('mcp__srv-1__b');
	});

	it('lets an explicit choice beat the catalog default in both directions', () => {
		registerMcpTools(SERVER, 'One', [tool('a'), tool('b')], ['a']);
		setMcpServers([server(SERVER, { toolEnabled: { a: false, b: true } }), server(OTHER)]);
		const names = getToolSchemas({ hasWorkingDir: false }).map((s) => s.function.name);
		expect(names).not.toContain('mcp__srv-1__a');
		expect(names).toContain('mcp__srv-1__b');
	});

	it('refuses a disabled tool at execution, not just in the schema', async () => {
		// The gate that actually protects the user: executeTool resolves names
		// against the FULL registry, so a small model can emit a call it was
		// never offered.
		registerMcpTools(SERVER, 'One', [tool('a'), tool('b')], ['a']);
		const out = await executeTool('mcp__srv-1__b', {}, ctx());
		expect(out.result).toContain('switched off');
		expect(invoke).not.toHaveBeenCalled();
	});

	it('withdraws every tool when its server is disabled', async () => {
		registerMcpTools(SERVER, 'One', [tool('a')], ['a']);
		setMcpServers([server(SERVER, { enabled: false }), server(OTHER)]);
		const names = getToolSchemas({ hasWorkingDir: false }).map((s) => s.function.name);
		expect(names).not.toContain('mcp__srv-1__a');
		const out = await executeTool('mcp__srv-1__a', {}, ctx());
		expect(out.result).toContain('switched off');
	});

	it('withdraws every tool when setup was never finished', async () => {
		registerMcpTools(SERVER, 'One', [tool('a')], ['a']);
		setMcpServers([server(SERVER, { setupComplete: false }), server(OTHER)]);
		const out = await executeTool('mcp__srv-1__a', {}, ctx());
		expect(out.result).toContain('switched off');
	});
});

describe('the approval decision rule', () => {
	it('runs a declared read-only tool without asking', () => {
		expect(
			requiresApproval({
				title: null,
				readOnlyHint: true,
				destructiveHint: null,
				idempotentHint: null,
				openWorldHint: null
			})
		).toBe(false);
	});

	it('prompts for anything that is not declared read-only', () => {
		expect(
			requiresApproval({
				title: null,
				readOnlyHint: false,
				destructiveHint: null,
				idempotentHint: null,
				openWorldHint: null
			})
		).toBe(true);
		expect(
			requiresApproval({
				title: null,
				readOnlyHint: null,
				destructiveHint: true,
				idempotentHint: null,
				openWorldHint: null
			})
		).toBe(true);
	});

	it('prompts when the server said nothing at all', () => {
		// The load-bearing case. MCP servers are arbitrary third-party programs;
		// the absence of a claim about safety is not a claim of safety, and
		// defaulting to "harmless" would put the least-documented servers on the
		// most permissive path.
		expect(requiresApproval(null)).toBe(true);
		expect(requiresApproval(undefined)).toBe(true);
	});
});

describe('approval flow', () => {
	const writeTool = tool('create_issue', {
		annotations: {
			title: null,
			readOnlyHint: false,
			destructiveHint: null,
			idempotentHint: null,
			openWorldHint: null
		}
	});

	it('does not prompt for a read-only tool', async () => {
		registerMcpTools(SERVER, 'One', [tool('search')], ['search']);
		invoke.mockResolvedValue(complete('ok'));
		const out = await executeTool('mcp__srv-1__search', {}, ctx());
		expect(getPendingMcpApproval()).toBeNull();
		expect(out.result).toBe('ok');
	});

	it('runs the call once allowed', async () => {
		registerMcpTools(SERVER, 'One', [writeTool], ['create_issue']);
		invoke.mockResolvedValue(complete('created'));
		const running = executeTool('mcp__srv-1__create_issue', { title: 'x' }, ctx());
		await answerApproval('allow_once');
		expect((await running).result).toBe('created');
	});

	it('returns a denial the model can act on rather than throwing', async () => {
		registerMcpTools(SERVER, 'One', [writeTool], ['create_issue']);
		const running = executeTool('mcp__srv-1__create_issue', {}, ctx());
		await answerApproval('deny');
		const out = await running;
		expect(out.result).toContain('declined');
		expect(out.result).toContain('Do not retry');
		expect(invoke).not.toHaveBeenCalled();
	});

	it('remembers "always" and does not prompt a second time', async () => {
		registerMcpTools(SERVER, 'One', [writeTool], ['create_issue']);
		invoke.mockResolvedValue(complete('created'));

		const first = executeTool('mcp__srv-1__create_issue', {}, ctx());
		await answerApproval('allow_always');
		await first;
		expect(isAlwaysAllowed(SERVER, 'create_issue')).toBe(true);

		const second = await executeTool('mcp__srv-1__create_issue', {}, ctx());
		expect(getPendingMcpApproval()).toBeNull();
		expect(second.result).toBe('created');
	});

	it('scopes "always" to one tool on one server', async () => {
		registerMcpTools(SERVER, 'One', [writeTool], ['create_issue']);
		invoke.mockResolvedValue(complete('created'));
		const first = executeTool('mcp__srv-1__create_issue', {}, ctx());
		await answerApproval('allow_always');
		await first;

		// Approving create_issue says nothing about another tool, or about the
		// same tool name on a different server.
		expect(isAlwaysAllowed(SERVER, 'delete_repo')).toBe(false);
		expect(isAlwaysAllowed(OTHER, 'create_issue')).toBe(false);
	});

	it('forgets a server’s approvals when it is removed', async () => {
		registerMcpTools(SERVER, 'One', [writeTool], ['create_issue']);
		invoke.mockResolvedValue(complete('created'));
		const first = executeTool('mcp__srv-1__create_issue', {}, ctx());
		await answerApproval('allow_always');
		await first;

		// A reinstall can bring back the same id with a different toolset; it
		// must not inherit approvals the user gave the old one.
		forgetServerApprovals(SERVER);
		expect(isAlwaysAllowed(SERVER, 'create_issue')).toBe(false);
	});
});

describe('multi round-trip requests', () => {
	const askingTool = tool('plan', {
		annotations: {
			title: null,
			readOnlyHint: true,
			destructiveHint: null,
			idempotentHint: null,
			openWorldHint: null
		}
	});

	function inputRequired(state: string): McpCallOutcome {
		return {
			type: 'inputRequired',
			requests: [
				{
					key: 'q1',
					method: 'elicitation/create',
					payload: { method: 'elicitation/create', params: { message: 'Which project?' } }
				}
			],
			requestState: state
		};
	}

	it('asks the user and retries with the answer', async () => {
		registerMcpTools(SERVER, 'One', [askingTool], ['plan']);
		invoke.mockResolvedValueOnce(inputRequired('state-1')).mockResolvedValueOnce(complete('done'));

		const askUser = vi.fn().mockResolvedValue({ kind: 'freeText', text: 'haruspex' });
		const out = await executeTool('mcp__srv-1__plan', {}, ctx({ interactive: true, askUser }));

		expect(askUser).toHaveBeenCalledWith({ question: 'Which project?', options: [] }, undefined);
		expect(invoke.mock.calls[1][1]).toMatchObject({
			requestState: 'state-1',
			inputResponses: { q1: { action: 'accept', content: { text: 'haruspex' } } }
		});
		expect(out.result).toBe('done');
	});

	it('fails cleanly with nobody present rather than hanging', async () => {
		// A scheduled or background run has no one to answer. Blocking there is
		// the failure ask_user_question already refuses to have.
		registerMcpTools(SERVER, 'One', [askingTool], ['plan']);
		invoke.mockResolvedValue(inputRequired('state-1'));
		const out = await executeTool('mcp__srv-1__plan', {}, ctx());
		expect(out.result).toContain('nobody is available');
		expect(invoke).toHaveBeenCalledTimes(1);
	});

	it('bounds the round trips', async () => {
		// A server that keeps asking is broken, not interactive, and every round
		// is another modal in front of the user.
		registerMcpTools(SERVER, 'One', [askingTool], ['plan']);
		invoke.mockResolvedValue(inputRequired('state-n'));
		const askUser = vi.fn().mockResolvedValue({ kind: 'freeText', text: 'x' });
		const out = await executeTool('mcp__srv-1__plan', {}, ctx({ interactive: true, askUser }));

		expect(invoke).toHaveBeenCalledTimes(MAX_MRTR_ROUNDS);
		expect(out.result).toContain('misbehaving');
	});

	it('reads the question out of the elicitation payload', () => {
		expect(
			elicitationMessage({
				key: 'q',
				method: 'elicitation/create',
				payload: { params: { message: 'Which project?' } }
			})
		).toBe('Which project?');
		expect(elicitationMessage({ key: 'q', method: null, payload: {} })).toBeNull();
		expect(
			elicitationMessage({ key: 'q', method: null, payload: { params: { message: '  ' } } })
		).toBeNull();
	});
});

describe('result formatting', () => {
	it('passes text blocks through', () => {
		expect(
			formatContent(
				{
					type: 'complete',
					content: [
						{ type: 'text', text: 'a' },
						{ type: 'text', text: 'b' }
					],
					structuredContent: null,
					isError: false
				},
				'x'
			)
		).toBe('a\nb');
	});

	it('names non-text content instead of dumping it', () => {
		// A screenshot-returning tool would otherwise flood the context with
		// base64 and blow the budget in one call.
		const out = formatContent(
			{
				type: 'complete',
				content: [{ type: 'image', data: 'AAAA...', mimeType: 'image/png' }],
				structuredContent: null,
				isError: false
			},
			'shot'
		);
		expect(out).toBe('[image content omitted]');
		expect(out).not.toContain('AAAA');
	});

	it("marks the server's own failure as an error", () => {
		const out = formatContent(
			{
				type: 'complete',
				content: [{ type: 'text', text: 'repo not found' }],
				structuredContent: null,
				isError: true
			},
			'get_repo'
		);
		expect(out).toContain('repo not found');
		expect(out.toLowerCase()).toContain('error');
	});

	it('says so when a tool returns nothing', () => {
		const out = formatContent(
			{ type: 'complete', content: [], structuredContent: null, isError: false },
			'quiet'
		);
		expect(out).toContain('returned nothing');
	});
});

describe('failure handling', () => {
	it('tells the server store a call failed, so a companion can be re-probed', async () => {
		// A failed call is the strongest available signal that a companion
		// application has dropped, and re-probing there is what turns "it
		// failed" into "Blender is not running".
		const seen: string[] = [];
		setToolFailureHook((id) => seen.push(id));
		registerMcpTools(SERVER, 'One', [tool('search')], ['search']);
		invoke.mockRejectedValue('boom');
		await executeTool('mcp__srv-1__search', {}, ctx());
		expect(seen).toEqual([SERVER]);
		setToolFailureHook(null);
	});

	it('does not fire the hook on a call that merely returns an error result', async () => {
		// The server answered. Nothing about the companion is in question.
		const seen: string[] = [];
		setToolFailureHook((id) => seen.push(id));
		registerMcpTools(SERVER, 'One', [tool('search')], ['search']);
		invoke.mockResolvedValue({
			type: 'complete',
			content: [{ type: 'text', text: 'not found' }],
			structuredContent: null,
			isError: true
		});
		await executeTool('mcp__srv-1__search', {}, ctx());
		expect(seen).toEqual([]);
		setToolFailureHook(null);
	});

	it('turns a transport failure into a tool error, not an exception', async () => {
		registerMcpTools(SERVER, 'One', [tool('search')], ['search']);
		invoke.mockRejectedValue('server is not connected');
		const out = await executeTool('mcp__srv-1__search', {}, ctx());
		expect(out.result).toContain('not connected');
	});

	it('says a tool is gone when its server stopped mid-turn', async () => {
		registerMcpTools(SERVER, 'One', [tool('search')], ['search']);
		setMcpServers([server(SERVER), server(OTHER)]);
		// The registry entry survives long enough for the model to call it, but
		// the descriptor is gone.
		unregisterMcpServer(SERVER);
		const out = await executeTool('mcp__srv-1__search', {}, ctx());
		expect(out.result).toContain('Unknown tool');
	});
});
