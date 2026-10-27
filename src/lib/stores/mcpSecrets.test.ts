import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpServerConfig } from '#lib/ipc/gen/McpServerConfig.ts';

const state = vi.hoisted(() => ({
	available: true,
	failKey: '',
	stored: new Map<string, string>()
}));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn(async (cmd: string, args?: { key: string; value?: string }) => {
		if (cmd === 'secret_available') return state.available;
		if (cmd === 'secret_set') {
			if (args!.key === state.failKey) throw new Error('store refused');
			return void state.stored.set(args!.key, args!.value!);
		}
		if (cmd === 'secret_delete') return void state.stored.delete(args!.key);
		throw new Error(`unexpected invoke: ${cmd}`);
	})
}));

import { getSettings, setMcpServers } from './settings';
import {
	customEnvProblem,
	forgetMcpSecrets,
	hasMcpSecret,
	migrateMcpSecrets,
	storeCustomEnv,
	storeMcpSecret
} from './mcpSecrets';
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
	state.failKey = '';
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

	it('never stay in the settings, even where nothing lasts', async () => {
		// Rust keeps it in memory for the session then.
		state.available = false;
		const c = await storeMcpSecret(server(), 'token', 'ghp_abc');
		expect(c.secrets.token).not.toBe('ghp_abc');
		expect(c.storedSecrets).toEqual(['token']);
		expect([...state.stored.values()]).toContain('ghp_abc');
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

	it('stay in the settings when the store refuses them, and move on a later start', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		setMcpServers([server({ secrets: { token: 'ghp_old', other: 'k_old' } })]);
		state.failKey = 'mcp:s1:token';
		await migrateMcpSecrets();
		let [s] = getSettings().integrations.mcp.servers;
		expect(s.secrets).toEqual({ token: 'ghp_old', other: '' });
		expect(s.storedSecrets).toEqual(['other']);

		state.failKey = '';
		await migrateMcpSecrets();
		[s] = getSettings().integrations.mcp.servers;
		expect(s.secrets).toEqual({ token: '', other: '' });
		expect(s.storedSecrets).toEqual(['other', 'token']);
		expect(state.stored.get('mcp:s1:token')).toBe('ghp_old');
	});

	it('stay in the settings where no store works', async () => {
		state.available = false;
		setMcpServers([server({ secrets: { token: 'ghp_old' } })]);
		await migrateMcpSecrets();
		expect(getSettings().integrations.mcp.servers[0].secrets.token).toBe('ghp_old');
		expect(state.stored.size).toBe(0);
	});

	it("keep a custom server's variables in the store under env: keys", async () => {
		const c = await storeCustomEnv(server({ source: { kind: 'custom', program: 'x', args: [] } }), [
			{ name: ' API_KEY ', value: 'sk_1' },
			{ name: '', value: '' }
		]);
		expect(state.stored.get('mcp:s1:env:API_KEY')).toBe('sk_1');
		expect(c.secrets).toEqual({ 'env:API_KEY': '' });
		expect(c.storedSecrets).toEqual(['env:API_KEY']);
	});

	it('refuse a variable name the server could not be given', () => {
		expect(customEnvProblem([{ name: 'API_KEY', value: 'x' }])).toBeNull();
		expect(customEnvProblem([{ name: '', value: '' }])).toBeNull();
		expect(customEnvProblem([{ name: '1KEY', value: 'x' }])).toMatch(/not a variable name/);
		expect(customEnvProblem([{ name: '', value: 'x' }])).toMatch(/not a variable name/);
		expect(
			customEnvProblem([
				{ name: 'A', value: '1' },
				{ name: 'A', value: '2' }
			])
		).toMatch(/twice/);
	});
});
