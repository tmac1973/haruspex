/**
 * Tauri IPC for the UI end-to-end tests, which run the frontend in a plain
 * browser. Loaded only in the `e2e` Vite mode, from `hooks.client.ts`.
 *
 * Each command the covered flows use answers from the table below with
 * fixture data. A command not in the table throws with its name, so a flow
 * that starts calling something new fails saying what to add, instead of
 * running on an `undefined` nobody chose.
 *
 * Tests reach in through `window.__e2e`: the calls made so far, and `mock()`
 * to replace one command's answer for the rest of the page's life.
 */
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { JOBS_DB } from './jobsDb';

type Args = Record<string, unknown> | undefined;
type Handler = (args: Args) => unknown;

interface E2eHooks {
	calls: { cmd: string; args: Args }[];
	/** Answer `cmd` with `value` from now on. */
	mock: (cmd: string, value: unknown) => void;
}

declare global {
	interface Window {
		__e2e?: E2eHooks;
	}
}

const none: Handler = () => null;
let messageId = 0;
const empty: Handler = () => [];

/** Answers for the commands the covered flows make. */
const TABLE: Record<string, Handler> = {
	// Boot, in remote mode: no local server, nothing persisted yet.
	'plugin:app|version': () => '0.0.0-e2e',
	'plugin:webview|set_webview_zoom': none,
	'plugin:window|set_title': none,
	get_server_status: () => ({ type: 'Stopped' }),
	get_cpu_fallback_state: none,
	inference_release_window: none,
	power_inhibit_release: none,
	power_inhibit_acquire: none,
	shell_platform_supported: () => true,
	remote_stop: () => ({ running: false, port: null, bind_all: false, sessions: 0 }),
	db_list_conversations: empty,
	db_recover_orphan_runs: () => 0,

	// Chat: persistence is write-only here, and the queue admits at once.
	db_create_conversation: none,
	db_rename_conversation: none,
	db_save_message: () => ++messageId,
	inference_queue_snapshot: empty,
	inference_acquire: (a) => ({
		id: a?.reqId,
		consumer: a?.consumer,
		state: 'running',
		enqueued_at: Date.now()
	}),
	inference_heartbeat: none,
	inference_cancel: none,
	inference_release: none,

	// Settings sections, each loading its own data.
	cmd_detect_hardware: () => ({
		gpu_available: true,
		gpu_name: 'E2E GPU',
		gpu_api: 'Vulkan',
		gpu_vram_mb: 16384,
		gpu_integrated: false,
		total_ram_mb: 32768,
		available_ram_mb: 24576,
		recommended_quant: 'Q4_K_M',
		recommended_context_size: 32768
	}),
	memory_model_present: () => false,
	memory_count: () => 0,
	list_audio_output_devices: empty,
	list_audio_input_devices: empty,
	email_list_providers: empty,
	secret_available: () => true,
	secret_store_kind: () => 'keychain',
	// No OAuth client in a test build, so Settings → Calendar offers no Google sign-in.
	google_sign_in_available: () => false,
	// No skills installed: chat turns list none, Settings → Skills shows an empty list.
	skills_list: empty,
	skills_user_dir: () => '/e2e/skills',
	skills_shipped: empty,
	secret_get: none,
	mcp_catalog: empty,
	mcp_runtimes_available: () => ({ node: true, npm: true, uv: true }),
	download_status: none,
	remote_status: () => ({ running: false, port: null, bind_all: false, sessions: 0 }),
	remote_lan_address: none,

	comfy_model_catalogue: empty,
	comfy_can_install_directly: () => false,
	// ComfyUI, answered per path: one GPU and one SD checkpoint.
	comfy_json: (a) => {
		const path = (a?.call as { path?: string } | undefined)?.path ?? '';
		const loaders: Record<string, [string, string[]]> = {
			'/object_info/CheckpointLoaderSimple': ['ckpt_name', ['e2e-sd15.safetensors']],
			'/object_info/UNETLoader': ['unet_name', []]
		};
		if (path === '/system_stats') return { devices: [{ name: 'E2E GPU' }] };
		const loader = loaders[path];
		if (loader) {
			const cls = path.split('/').pop()!;
			return { [cls]: { input: { required: { [loader[0]]: [loader[1]] } } } };
		}
		throw new Error(`e2e: comfy_json has no fixture for ${path}`);
	},

	// Jobs: an in-memory database, so a job made in a test can be run.
	...JOBS_DB,

	// Tools.
	proxy_search: () => [
		{
			title: 'Liver of Piacenza',
			url: 'https://en.wikipedia.org/wiki/Liver_of_Piacenza',
			snippet: 'A life-sized bronze model of a sheep’s liver covered in Etruscan inscriptions.'
		}
	]
};

export function installMocks(): void {
	const calls: E2eHooks['calls'] = [];
	const overrides = new Map<string, unknown>();
	mockWindows('main');
	// The flag the real runtime sets; code that picks IPC over `fetch` when
	// it is inside Tauri reads it (the ComfyUI client does).
	(globalThis as { isTauri?: boolean }).isTauri = true;
	mockIPC(
		(cmd, args) => {
			calls.push({ cmd, args: args as Args });
			if (overrides.has(cmd)) return overrides.get(cmd);
			const handler = TABLE[cmd];
			if (!handler) {
				const message = `e2e: no mock for IPC command "${cmd}" (src/lib/e2e/installMocks.ts)`;
				// Logged as well as thrown: app code often catches IPC errors and
				// carries on, and the fixture fails the test on this line.
				console.error(message);
				throw new Error(message);
			}
			return handler(args as Args);
		},
		{ shouldMockEvents: true }
	);
	window.__e2e = { calls, mock: (cmd, value) => overrides.set(cmd, value) };
}
