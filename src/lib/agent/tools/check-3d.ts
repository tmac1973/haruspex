/**
 * `check_3d`: the 3D helper's tool (Settings → Code → Helpers). The agent
 * writes a Three.js build module and this builds it in the sandbox, exports
 * the GLB and returns a report and a six-view render sheet; or it checks a
 * .glb/.gltf made another way (Blender) and returns the same. No model.
 * The call itself is `#lib/helpers/three/call.ts`; this gives it the app's
 * files, its sandboxed frame and the agent's pending images.
 */
import { assetIo, writeAsset } from '#lib/agent/tools/_assetIo.ts';
import { ctxCwd } from '#lib/agent/tools/_helpers.ts';
import { READ_ONLY_REFUSAL } from '#lib/agent/tools/_codeTabProfile.ts';
import { MAX_PENDING_IMAGES } from '#lib/agent/tools/fs-read.ts';
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolError, toolResult, type ToolContext } from '#lib/agent/tools/types.ts';
import {
	CHECK_3D_DESCRIPTION,
	CHECK_3D_PARAMETERS,
	runCheck3d,
	type Check3dHost
} from '#lib/helpers/three/call.ts';
import { MOTION_NOTE, SHEET_NOTE } from '#lib/helpers/three/load.ts';
import { check3dFile } from '#lib/helpers/three/output.ts';
import { runHiddenFrame } from '#lib/sandbox/hiddenFrame.ts';

export { MOTION_NOTE, SHEET_NOTE };

/** The app as `check_3d`'s host. */
function appHost(ctx: ToolContext): Check3dHost {
	const io = assetIo(ctx);
	return {
		read: (path) => io.read(path),
		write: (path, bytes) => writeAsset(path, bytes, true, false, io),
		cwd: ctxCwd(ctx),
		runFrame: runHiddenFrame,
		attachSheet: (path, png) => attachSheet(ctx, path, png),
		onProgress: ctx.onProgress,
		signal: ctx.signal
	};
}

async function executeCheck3d(args: Record<string, unknown>, ctx: ToolContext) {
	if (ctx.codeReadOnly) return toolResult(toolError(READ_ONLY_REFUSAL));
	const reply = await runCheck3d(args, appHost(ctx));
	if ('error' in reply) return toolResult(toolError(reply.error));
	return toolResult(reply.text, reply.png);
}

/** Give the agent the sheet when its model can see it; whether it did. */
function attachSheet(ctx: ToolContext, path: string, png: string): boolean {
	if (ctx.visionSupported === false) return false;
	if (ctx.pendingImages.length >= MAX_PENDING_IMAGES) return false;
	ctx.pendingImages.push({ path, dataUrl: png });
	return true;
}

registerTool({
	category: 'fs',
	schema: {
		type: 'function',
		function: {
			name: 'check_3d',
			description: CHECK_3D_DESCRIPTION,
			parameters: CHECK_3D_PARAMETERS
		}
	},
	execute: executeCheck3d,
	// The model file: the step card links it (`SearchStep.svelte`).
	displayLabel: (args) => check3dFile(args) ?? String(args.path ?? '')
});
