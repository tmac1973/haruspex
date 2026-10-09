/**
 * How this Haruspex is set up right now, for the `haruspex_docs` tool: many
 * questions about the app are really about its state ("why can't it see my
 * calendar?"), which the guide can't answer.
 *
 * On/off and counts only. Never a key, password, address, account name,
 * server URL or file path: the model may repeat any of this, and a remote
 * model or provider sees it.
 */

import { getVersion } from '@tauri-apps/api/app';
import type { BackendOverride } from '#lib/api.ts';
import { resolveBackendDescriptor } from '#lib/inference/descriptor.ts';
import { skillsAutonomous } from '#lib/skills/client.ts';
import { memoryActive } from '#lib/stores/memory.svelte.ts';
import {
	enabledDavAccounts,
	getActiveLocalModelFilename,
	getSettings,
	startableMcpServers
} from '#lib/stores/settings.ts';

const BACKEND: Record<string, string> = {
	local: 'the local model, on this computer',
	remote: 'a model server set in Settings → Inference',
	openrouter: 'OpenRouter (cloud)'
};

/** A model picked for this conversation alone (a Code session, a job). */
const OVERRIDE: Record<string, string> = {
	remote: 'a model server picked for this conversation, not the one in Settings → Inference',
	openrouter:
		'OpenRouter (cloud), picked for this conversation, not the model in Settings → Inference'
};

const IMAGE: Record<string, string> = {
	none: 'off',
	comfyui: 'on, through a ComfyUI server',
	local: 'on, with the bundled engine'
};

const onOff = (on: boolean) => (on ? 'on' : 'off');

/**
 * The status block, as Markdown. `override` is the model the asking turn
 * actually runs on when it isn't Settings' (a Code session's or a job's own
 * pick); without it the block would name the Settings model, and the model
 * would report being something it isn't.
 */
export async function guideStatus(override?: BackendOverride): Promise<string> {
	const s = getSettings();
	const backend = resolveBackendDescriptor(override);
	const via = (override && OVERRIDE[backend.kind]) || BACKEND[backend.kind] || backend.kind;
	const model =
		backend.kind === 'local' ? getActiveLocalModelFilename() || 'none chosen' : backend.modelId;
	const version = await getVersion().catch(() => 'unknown');
	const dav = enabledDavAccounts();
	const emails = s.integrations.email.accounts.filter((a) => a.enabled).length;
	const limit = s.commandMemoryLimitPercent;
	return [
		'## This Haruspex right now',
		`- Version: ${version}`,
		`- Model: ${model}, through ${via}; context ${backend.contextSize.toLocaleString('en-US')} tokens; sees images: ${backend.vision ? 'yes' : 'no'}`,
		`- Memory across chats: ${onOff(memoryActive())}`,
		`- Python sandbox: ${onOff(s.sandboxEnabled)}`,
		`- Image generation: ${IMAGE[s.imageBackendKind] ?? s.imageBackendKind}`,
		`- Screen capture: ${onOff(s.screenCaptureEnabled)}`,
		`- Model uses skills by itself: ${skillsAutonomous() ? 'yes' : 'no'} (setting: ${s.skills.autonomous})`,
		`- Memory limit for commands and terminals: ${limit > 0 ? `${limit}% of RAM` : 'off'}`,
		`- Email accounts switched on: ${emails}`,
		`- Calendar and contacts accounts switched on: ${dav.length}`,
		`- MCP servers switched on: ${startableMcpServers().length}`
	].join('\n');
}
