/**
 * The 3D helper: `check_3d` (`#lib/agent/tools/check-3d.ts`), and
 * `delegate_3d` (`#lib/agent/tools/delegate-3d.ts`) while a delegate model is
 * set in its settings or the session's own (`delegateConfig.ts`).
 */
import type { SessionHelperConfig } from '#lib/code/db.ts';
import { overrideModelLabel } from '#lib/code/backends.ts';
import { registerHelper } from '#lib/helpers/registry.ts';
import { delegate3dConfig, parseDelegate3dConfig } from '#lib/helpers/three/delegateConfig.ts';

/** The TOOLS line for `delegate_3d`, while a delegate is set; '' otherwise. */
export function threeHelperPrompt(session: SessionHelperConfig | null = null): string {
	const backend = delegate3dConfig(session).backend;
	if (!backend) return '';
	const { label } = overrideModelLabel(backend);
	return `- delegate_3d — hand a new 3D asset, or a change to one it made, to ${label}; describe it fully. It runs in the background and reports in a new turn; pass wait only when your next step needs the .glb. Use check_3d yourself to look at or measure an asset, not to build one.`;
}

registerHelper({
	id: '3d',
	label: '3D',
	summary: 'Builds and renders 3D models the agent writes.',
	tooltip:
		'Runs a Three.js build module or checks a .glb file, then shows the agent a six-view render, a size and parts report and checks on each animation clip, or one clip moving. That needs no model and no network; with a model under Delegate to, the agent can also hand 3D work to it.',
	tools: ['check_3d', 'delegate_3d'],
	writes: true,
	prompt: threeHelperPrompt,
	settings: {
		parse: parseDelegate3dConfig,
		component: () => import('#lib/helpers/three/ThreeSettings.svelte')
	}
});
