import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpApprovalRequest } from '#lib/stores/mcpApproval.svelte.ts';

// The store is module-level $state — re-import fresh per test so a pending
// prompt can't leak between tests.
async function freshStore() {
	return import('#lib/stores/mcpApproval.svelte.ts');
}

const ALWAYS_KEY = 'haruspex.mcp.alwaysAllow';

function request(toolName: string): McpApprovalRequest {
	return {
		serverId: 'srv-1',
		serverLabel: 'GitHub',
		toolName,
		description: null,
		annotations: null,
		args: { repo: 'a/b' }
	};
}

describe('MCP approval prompts', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it('rejects a second overlapping ask and leaves the first pending', async () => {
		const { askMcpApproval, getPendingMcpApproval, resolveMcpApproval } = await freshStore();

		const first = askMcpApproval(request('create_issue'));
		await expect(askMcpApproval(request('delete_repository'))).rejects.toThrow(/already pending/);

		// First prompt is untouched by the rejected second ask.
		expect(getPendingMcpApproval()!.toolName).toBe('create_issue');
		resolveMcpApproval('allow_once');
		await expect(first).resolves.toBe('allow_once');
		expect(getPendingMcpApproval()).toBeNull();
	});

	it('supports sequential prompts once the previous one resolves', async () => {
		const { askMcpApproval, resolveMcpApproval } = await freshStore();

		const first = askMcpApproval(request('create_issue'));
		resolveMcpApproval('deny');
		await expect(first).resolves.toBe('deny');

		const second = askMcpApproval(request('delete_repository'));
		resolveMcpApproval('allow_always');
		await expect(second).resolves.toBe('allow_always');
	});
});

describe('remembered MCP approvals in storage', () => {
	beforeEach(() => {
		vi.resetModules();
		localStorage.clear();
	});

	it.each([
		['corrupt JSON', '{not json'],
		['an object', JSON.stringify({ 'srv-1\u0000create_issue': true })],
		['a bare string', JSON.stringify('srv-1\u0000create_issue')],
		['null', 'null']
	])('reads %s as nothing approved', async (_what, stored) => {
		localStorage.setItem(ALWAYS_KEY, stored);
		const { isAlwaysAllowed } = await freshStore();
		expect(isAlwaysAllowed('srv-1', 'create_issue')).toBe(false);
	});

	it('ignores entries that are not strings and keeps the ones that are', async () => {
		localStorage.setItem(
			ALWAYS_KEY,
			JSON.stringify([42, null, { k: 1 }, 'srv-1\u0000create_issue'])
		);
		const { isAlwaysAllowed } = await freshStore();
		expect(isAlwaysAllowed('srv-1', 'create_issue')).toBe(true);
		expect(isAlwaysAllowed('srv-1', 'delete_repository')).toBe(false);
	});

	it('replaces a corrupt store with a working one on the next approval', async () => {
		localStorage.setItem(ALWAYS_KEY, '{not json');
		const { isAlwaysAllowed, rememberAlwaysAllow } = await freshStore();

		rememberAlwaysAllow('srv-1', 'create_issue');

		expect(isAlwaysAllowed('srv-1', 'create_issue')).toBe(true);
		expect(JSON.parse(localStorage.getItem(ALWAYS_KEY)!)).toEqual(['srv-1\u0000create_issue']);
	});
});
