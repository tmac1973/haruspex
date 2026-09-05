/**
 * MCP tools, registered at runtime.
 *
 * A server's tools are not known until it has been installed, started and
 * asked. They join the same registry `Map` as every built-in tool rather than
 * living in a parallel list, which is what keeps `coerceArgsToSchema` (absorbing
 * the stringified-JSON and wrong-typed arguments small models emit), the
 * nearest-name suggestion for hallucinated calls, and display labels all working
 * with no second implementation.
 *
 * # Naming
 *
 * `mcp__<serverId>__<toolName>`. Two servers exposing `search` must not
 * collide, and the prefix makes it obvious in the UI and in logs where a tool
 * came from. The server's own name is kept in the registration for display and
 * for the `tools/call` that actually goes out.
 *
 * # The MRTR loop lives here
 *
 * Phase 03 deliberately stopped at one round trip: a modern server can answer a
 * `tools/call` with a question instead of a result, and the machinery for asking
 * a person is here, not in Rust. `ToolContext.askUser` already routes a question
 * to whoever can answer it — including a remote guest rather than whoever is at
 * this keyboard — so the loop is driven from this side and there is exactly one
 * question path in the app.
 */

import { invoke } from '@tauri-apps/api/core';
import { IPC } from '$lib/ipc/commands';
import type { McpToolDescriptor } from '$lib/ipc/gen/McpToolDescriptor';
import type { McpCallOutcome } from '$lib/ipc/gen/McpCallOutcome';
import type { McpInputRequest } from '$lib/ipc/gen/McpInputRequest';
import { registerTool, unregisterTool } from './registry';
import { clearMcpDefaultTools, mcpToolName, setMcpDefaultTools } from './mcp-names';
import { toolResult, toolError, type ToolContext, type ToolExecOutput } from './types';
import {
	askMcpApproval,
	isAlwaysAllowed,
	rememberAlwaysAllow,
	requiresApproval
} from '$lib/stores/mcpApproval.svelte';

/**
 * Maximum MRTR round trips for one tool call.
 *
 * A server that keeps asking is a broken server, not an interactive one, and
 * each round is a modal in front of the user. Matches the default the Tier 1
 * SDKs use.
 */
export const MAX_MRTR_ROUNDS = 10;

/** Registered MCP tool names, per server, so unregistering is exact. */
const registered = new Map<string, Set<string>>();

/** Everything the executor and the approval card need, per registered name. */
interface McpToolEntry {
	serverId: string;
	serverLabel: string;
	descriptor: McpToolDescriptor;
}

const entries = new Map<string, McpToolEntry>();

/**
 * Expose one server's tools to the model.
 *
 * Replaces any previous registration for the same server, so a reconnect that
 * discovers a changed tool list does not leave the old names callable.
 */
export function registerMcpTools(
	serverId: string,
	serverLabel: string,
	tools: McpToolDescriptor[],
	defaultTools: string[] = []
): void {
	unregisterMcpServer(serverId);
	setMcpDefaultTools(serverId, defaultTools);
	const names = new Set<string>();

	for (const descriptor of tools) {
		const name = mcpToolName(serverId, descriptor.name);
		names.add(name);
		entries.set(name, { serverId, serverLabel, descriptor });
		registerTool({
			schema: {
				type: 'function',
				function: {
					name,
					description: descriptor.description ?? `${descriptor.name} (via ${serverLabel})`,
					// The server's own schema, passed through untouched. Rewriting
					// it here would mean the model is told something different from
					// what the server will actually validate.
					parameters: (descriptor.inputSchema ?? { type: 'object' }) as Record<string, unknown>
				}
			},
			execute: (args, ctx) => executeMcpTool(name, args, ctx),
			displayLabel: () => `${descriptor.title ?? descriptor.name} · ${serverLabel}`,
			category: 'mcp'
		});
	}

	registered.set(serverId, names);
}

/** Withdraw one server's tools. Called when it stops, is disabled or removed. */
export function unregisterMcpServer(serverId: string): void {
	const names = registered.get(serverId);
	if (!names) return;
	for (const name of names) {
		unregisterTool(name);
		entries.delete(name);
	}
	registered.delete(serverId);
	clearMcpDefaultTools(serverId);
}

/** The descriptor behind a registered name, for the UI and the gate. */
export function mcpToolEntry(name: string): McpToolEntry | null {
	return entries.get(name) ?? null;
}

/** Every registered MCP tool name, for the budget and for tests. */
export function registeredMcpToolNames(): string[] {
	return [...entries.keys()].sort();
}

/**
 * Run one MCP tool, including approval and any MRTR rounds.
 *
 * Every failure is a tool *result*, not an exception: the model can read a
 * denial or an error and choose something else, whereas a thrown error unwinds
 * the whole turn.
 */
async function executeMcpTool(
	name: string,
	args: Record<string, unknown>,
	ctx: ToolContext
): Promise<ToolExecOutput> {
	const entry = entries.get(name);
	if (!entry) {
		return toolResult(toolError(`${name} is no longer available; its server has stopped.`));
	}
	const { serverId, serverLabel, descriptor } = entry;

	const approved = await resolveApproval(entry, args);
	if (!approved) {
		return toolResult(
			toolError(
				`The user declined to run ${descriptor.name} on ${serverLabel}. ` +
					`Do not retry it; continue without it or ask them what to do instead.`
			)
		);
	}

	let inputResponses: Record<string, unknown> | null = null;
	let requestState: string | null = null;

	for (let round = 0; round < MAX_MRTR_ROUNDS; round++) {
		let outcome: McpCallOutcome;
		try {
			outcome = await invoke<McpCallOutcome>(IPC.mcp_call_tool, {
				id: serverId,
				name: descriptor.name,
				arguments: args,
				inputResponses,
				requestState
			});
		} catch (e) {
			return toolResult(toolError(`${descriptor.name} failed: ${String(e)}`));
		}

		if (outcome.type === 'complete') {
			return toolResult(formatContent(outcome, descriptor.name));
		}

		// The server asked something. Answering needs a person.
		const answers = await answerInputRequests(outcome.requests, entry, ctx);
		if (typeof answers === 'string') return toolResult(toolError(answers));
		inputResponses = answers;
		requestState = outcome.requestState;
	}

	return toolResult(
		toolError(
			`${descriptor.name} asked for input ${MAX_MRTR_ROUNDS} times without finishing. ` +
				`The server is misbehaving; do not retry it.`
		)
	);
}

/** True to run, false if the user said no. */
async function resolveApproval(
	entry: McpToolEntry,
	args: Record<string, unknown>
): Promise<boolean> {
	const { serverId, serverLabel, descriptor } = entry;
	if (!requiresApproval(descriptor.annotations)) return true;
	if (isAlwaysAllowed(serverId, descriptor.name)) return true;

	const choice = await askMcpApproval({
		serverId,
		serverLabel,
		toolName: descriptor.name,
		description: descriptor.description,
		annotations: descriptor.annotations,
		args
	});
	if (choice === 'allow_always') {
		rememberAlwaysAllow(serverId, descriptor.name);
		return true;
	}
	return choice === 'allow_once';
}

/**
 * Put the server's questions to the user, one at a time.
 *
 * Returns the `inputResponses` map on success, or an error string to fail the
 * call with. A string rather than a throw, for the same reason as everywhere
 * else here: the model can act on a message.
 */
async function answerInputRequests(
	requests: McpInputRequest[],
	entry: McpToolEntry,
	ctx: ToolContext
): Promise<Record<string, unknown> | string> {
	// Fail safe rather than hang. A background or scheduled run has nobody to
	// answer, and blocking forever there is the failure `ask_user_question`
	// already refuses to have.
	if (!ctx.askUser || !ctx.interactive) {
		return (
			`${entry.descriptor.name} needs to ask a question, but nobody is available to ` +
			`answer it in this context. Continue without this tool.`
		);
	}
	if (requests.length === 0) {
		return `${entry.descriptor.name} asked for input without saying what it needed.`;
	}

	const responses: Record<string, unknown> = {};
	for (const request of requests) {
		const question = elicitationMessage(request) ?? `${entry.serverLabel} needs more information.`;
		// Deliberately unguarded: `askUser` rejects with an AbortError when the
		// user cancels, and that has to unwind the turn the way a job-cancel
		// does. Catching it here would feed the model an answer nobody gave.
		const answer = await ctx.askUser({ question, options: [] }, ctx.signal);
		responses[request.key] =
			answer.kind === 'freeText'
				? { action: 'accept', content: { text: answer.text } }
				: { action: 'accept', content: { text: answer.labels.join(', ') } };
	}
	return responses;
}

/** The human-readable prompt inside an elicitation payload, if there is one. */
export function elicitationMessage(request: McpInputRequest): string | null {
	const payload = request.payload as { params?: { message?: unknown } } | null;
	const message = payload?.params?.message;
	return typeof message === 'string' && message.trim() ? message : null;
}

/**
 * Render a completed call for the model.
 *
 * MCP content is an array of typed blocks. Text is passed through; anything
 * else is named rather than dumped, so a screenshot-returning tool does not
 * flood the context with base64.
 */
export function formatContent(
	outcome: Extract<McpCallOutcome, { type: 'complete' }>,
	toolName: string
): string {
	const parts: string[] = [];
	const content = Array.isArray(outcome.content) ? outcome.content : [];
	for (const block of content) {
		const typed = block as { type?: unknown; text?: unknown };
		if (typed.type === 'text' && typeof typed.text === 'string') {
			parts.push(typed.text);
		} else if (typeof typed.type === 'string') {
			parts.push(`[${typed.type} content omitted]`);
		}
	}
	if (outcome.structuredContent !== null && outcome.structuredContent !== undefined) {
		parts.push(JSON.stringify(outcome.structuredContent));
	}
	const body = parts.join('\n').trim();
	if (!body)
		return outcome.isError ? toolError(`${toolName} failed.`) : `${toolName} returned nothing.`;
	// The server's own failure flag, kept distinct from a transport failure:
	// the tool ran and reported a problem on its own terms.
	return outcome.isError ? toolError(body) : body;
}
