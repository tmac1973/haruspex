/** The 3D helper: `check_3d` (`#lib/agent/tools/check-3d.ts`). */
import { registerHelper } from '#lib/helpers/registry.ts';

registerHelper({
	id: '3d',
	label: '3D',
	summary: 'Builds and renders 3D models the agent writes.',
	tooltip:
		'Runs a Three.js build module or checks a .glb file, then shows the agent a six-view render and a size and parts report. Needs no model and no network.',
	tools: ['check_3d'],
	writes: true
});
