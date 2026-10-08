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

const IMAGE: Record<string, string> = {
	none: 'off',
	comfyui: 'on, through a ComfyUI server',
	local: 'on, with the bundled engine'
};

const onOff = (on: boolean) => (on ? 'on' : 'off');

/** The status block, as Markdown. */
export async function guideStatus(): Promise<string> {
	const s = getSettings();
	const backend = resolveBackendDescriptor();
	const model =
		backend.kind === 'local' ? getActiveLocalModelFilename() || 'none chosen' : backend.modelId;
	const version = await getVersion().catch(() => 'unknown');
	const dav = enabledDavAccounts();
	const emails = s.integrations.email.accounts.filter((a) => a.enabled).length;
	const limit = s.commandMemoryLimitPercent;
	return [
		'## This Haruspex right now',
		`- Version: ${version}`,
		`- Model: ${model}, through ${BACKEND[backend.kind] ?? backend.kind}; context ${backend.contextSize.toLocaleString('en-US')} tokens; sees images: ${backend.vision ? 'yes' : 'no'}`,
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
