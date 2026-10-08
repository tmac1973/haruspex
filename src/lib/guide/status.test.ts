import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.2.3' }));
vi.mock('#lib/inference/descriptor.ts', () => ({
	resolveBackendDescriptor: () => ({
		kind: 'remote',
		modelId: 'qwen-big',
		contextSize: 65536,
		vision: true,
		baseUrl: 'https://gpu.secret.example:8443',
		apiKey: 'sk-SECRET-KEY'
	})
}));
vi.mock('#lib/skills/client.ts', () => ({ skillsAutonomous: () => true }));
vi.mock('#lib/stores/memory.svelte.ts', () => ({ memoryActive: () => true }));
vi.mock('#lib/stores/settings.ts', () => ({
	getSettings: () => ({
		sandboxEnabled: false,
		imageBackendKind: 'comfyui',
		screenCaptureEnabled: true,
		commandMemoryLimitPercent: 0,
		skills: { autonomous: 'on' },
		integrations: {
			email: {
				accounts: [
					{ enabled: true, address: 'tim@secret.example', password: 'hunter2' },
					{ enabled: false, address: 'old@secret.example' }
				]
			}
		}
	}),
	getActiveLocalModelFilename: () => 'local.gguf',
	enabledDavAccounts: () => [
		{ address: 'https://dav.secret.example', username: 'tim', password: 'hunter2' }
	],
	startableMcpServers: () => [{ label: 'GitHub', env: { TOKEN: 'ghp_SECRET' } }]
}));

import { guideStatus } from './status';

describe('guideStatus', () => {
	it('says what is set up, as on/off and counts', async () => {
		const s = await guideStatus();
		expect(s).toContain('Version: 0.2.3');
		expect(s).toContain('Model: qwen-big, through a model server set in Settings → Inference');
		expect(s).toContain('context 65,536 tokens; sees images: yes');
		expect(s).toContain('Memory across chats: on');
		expect(s).toContain('Python sandbox: off');
		expect(s).toContain('Image generation: on, through a ComfyUI server');
		expect(s).toContain('Screen capture: on');
		expect(s).toContain('Model uses skills by itself: yes (setting: on)');
		expect(s).toContain('Memory limit for commands and terminals: off');
		expect(s).toContain('Email accounts switched on: 1');
		expect(s).toContain('Calendar and contacts accounts switched on: 1');
		expect(s).toContain('MCP servers switched on: 1');
	});

	it('never carries a key, password, address or URL', async () => {
		const s = await guideStatus();
		for (const secret of ['secret', 'hunter2', 'sk-', 'ghp_', '@', 'https://', 'GitHub']) {
			expect(s, secret).not.toContain(secret);
		}
	});
});
