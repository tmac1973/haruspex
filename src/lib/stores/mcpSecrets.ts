/**
 * MCP setup secrets (tokens, API keys, a remote server's bearer), kept out of
 * the settings (see `./secrets`).
 *
 * Each is stored under `mcp:<server id>:<key>`; the config keeps an empty
 * value in `secrets` and lists the key in `storedSecrets`. Rust reads them
 * back when it starts the server, runs a setup command or connects — never
 * handing them to the webview.
 */
import { getSettings, setMcpServers } from './settings';
import type { McpServerConfig } from '$lib/ipc/gen/McpServerConfig';
import { deleteSecret, keepSecret, secretStoreAvailable, setSecret } from './secrets';

export function mcpSecretKey(serverId: string, key: string): string {
	return `mcp:${serverId}:${key}`;
}

function withStored(config: McpServerConfig, key: string, stored: boolean): string[] {
	const rest = (config.storedSecrets ?? []).filter((k) => k !== key);
	return stored ? [...rest, key] : rest;
}

/** The config with `value` kept for `key`. An empty value clears it. */
export async function storeMcpSecret(
	config: McpServerConfig,
	key: string,
	value: string
): Promise<McpServerConfig> {
	if (!value) {
		if (config.storedSecrets?.includes(key)) await deleteSecret(mcpSecretKey(config.id, key));
		return {
			...config,
			secrets: { ...config.secrets, [key]: '' },
			storedSecrets: withStored(config, key, false)
		};
	}
	const { inline, ref } = await keepSecret(mcpSecretKey(config.id, key), value);
	return {
		...config,
		secrets: { ...config.secrets, [key]: inline },
		storedSecrets: withStored(config, key, ref !== undefined)
	};
}

/** Whether `key` has a value, wherever it is kept. */
export function hasMcpSecret(config: McpServerConfig, key: string): boolean {
	return (config.secrets[key] ?? '').trim() !== '' || !!config.storedSecrets?.includes(key);
}

/** Delete every secret a server kept. Called when the server is removed. */
export async function forgetMcpSecrets(config: McpServerConfig): Promise<void> {
	for (const key of config.storedSecrets ?? []) await deleteSecret(mcpSecretKey(config.id, key));
}

/** Move secrets still inline in the settings into the store. Runs at every
 *  start; a no-op once done or where no store works. */
export async function migrateMcpSecrets(): Promise<void> {
	const pending = getSettings().integrations.mcp.servers.filter((s) =>
		Object.entries(s.secrets).some(([k, v]) => v && !s.storedSecrets?.includes(k))
	);
	if (pending.length === 0 || !(await secretStoreAvailable())) return;

	const moved = new Map<string, Map<string, string>>();
	for (const server of pending) {
		for (const [key, value] of Object.entries(server.secrets)) {
			if (!value || server.storedSecrets?.includes(key)) continue;
			try {
				await setSecret(mcpSecretKey(server.id, key), value);
				if (!moved.has(server.id)) moved.set(server.id, new Map());
				moved.get(server.id)!.set(key, value);
			} catch (e) {
				console.warn(`Could not move an MCP secret for ${server.id} out of the settings:`, e);
			}
		}
	}
	if (moved.size === 0) return;
	setMcpServers(
		getSettings().integrations.mcp.servers.map((server) => {
			const keys = moved.get(server.id);
			if (!keys) return server;
			const secrets = { ...server.secrets };
			const stored = new Set(server.storedSecrets ?? []);
			for (const [key, value] of keys) {
				if (secrets[key] !== value) continue; // edited meanwhile
				secrets[key] = '';
				stored.add(key);
			}
			return { ...server, secrets, storedSecrets: [...stored] };
		})
	);
}
