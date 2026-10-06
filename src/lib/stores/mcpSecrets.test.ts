import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpServerConfig } from '#lib/ipc/gen/McpServerConfig.ts';

const state = vi.hoisted(() => ({ available: true, stored: new Map<string, string>() }));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn(async (cmd: string, args?: { key: string; value?: string }) => {
		if (cmd === 'secret_available') return state.available;
		if (cmd === 'secret_set') return void state.stored.set(args!.key, args!.value!);
		if (cmd === 'secret_delete') return void state.stored.delete(args!.key);
		throw new Error(`unexpected invoke: ${cmd}`);
	})
}));

import { getSettings, setMcpServers } from './settings';
import { forgetMcpSecrets, hasMcpSecret, migrateMcpSecrets, storeMcpSecret } from './mcpSecrets';
import { isStepSatisfied, setupStateOf } from './mcpSetup';

function server(over: Partial<McpServerConfig> = {}): McpServerConfig {
	return {
		id: 's1',
		label: 'GitHub',
		enabled: true,
		source: { kind: 'catalog', entryId: 'github' },
		secrets: {},
		toolEnabled: {},
		proxyUse: 'auto',
		setupComplete: true,
		addonProjects: [],
		...over
	};
}

beforeEach(() => {
	state.available = true;
	state.stored.clear();
	setMcpServers([]);
});

describe('MCP secrets', () => {
	it('are stored per server and key, with the config keeping only that one exists', async () => {
		const c = await storeMcpSecret(server(), 'token', 'ghp_abc');
		expect(state.stored.get('mcp:s1:token')).toBe('ghp_abc');
		expect(c.secrets.token).toBe('');
		expect(c.storedSecrets).toEqual(['token']);
		expect(hasMcpSecret(c, 'token')).toBe(true);
	});

	it('satisfy a setup step once stored', async () => {
		const c = await storeMcpSecret(server(), 'token', 'ghp_abc');
		const step = {
			kind: 'secret',
			key: 'token',
			label: 'Token',
			help: null,
			optional: false
		} as const;
		expect(isStepSatisfied(step as never, setupStateOf(c, [], []), 0)).toBe(true);
	});

	it('stay inline only where no store works', async () => {
		state.available = false;
		const c = await storeMcpSecret(server(), 'token', 'ghp_abc');
		expect(c.secrets.token).toBe('ghp_abc');
		expect(c.storedSecrets).toEqual([]);
	});

	it('are deleted with the server', async () => {
		const c = await storeMcpSecret(server(), 'token', 'ghp_abc');
		await forgetMcpSecrets(c);
		expect(state.stored.size).toBe(0);
	});

	it('move out of the settings at startup, once', async () => {
		setMcpServers([server({ secrets: { token: 'ghp_old', empty: '' } })]);
		await migrateMcpSecrets();
		const [s] = getSettings().integrations.mcp.servers;
		expect(s.secrets).toEqual({ token: '', empty: '' });
		expect(s.storedSecrets).toEqual(['token']);
		expect(state.stored.get('mcp:s1:token')).toBe('ghp_old');

		state.stored.clear();
		await migrateMcpSecrets();
		expect(state.stored.size).toBe(0);
	});
});
