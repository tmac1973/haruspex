/**
 * `camera_save_preset`: save where an ONVIF camera points now as a preset on
 * the camera, then keep the presets it reads back in the camera's settings,
 * as Refresh presets in Settings → Cameras does. It goes through
 * `_cameraGate.ts` like the other camera tools, and asks on an Ask camera.
 */

import { invoke } from '@tauri-apps/api/core';
import type { CameraConfig } from '#lib/ipc/gen/CameraConfig.ts';
import type { CameraPresetSaved } from '#lib/ipc/gen/CameraPresetSaved.ts';
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolResult, toolError } from '#lib/agent/tools/types.ts';
import { cameraAccessRefusal, cameraGate, resolveCamera } from '#lib/agent/tools/_cameraGate.ts';
import { CAMERA_PARAM, canAim, errorText, refused } from '#lib/agent/tools/camera.ts';
import { getSettings, setCameras } from '#lib/stores/settings.ts';
import { withCameraActivity } from '#lib/stores/cameraActivity.svelte.ts';

export const NO_PRESETS =
	'Only a network camera with Pan/tilt set to ONVIF in Settings → Cameras has presets.';
export const NAME_THE_PRESET = 'Name the preset.';

registerTool({
	category: 'camera',
	schema: {
		type: 'function',
		function: {
			name: 'camera_save_preset',
			description:
				"Save where one of the user's ONVIF pan/tilt cameras points now as a preset on the camera, so camera_look can go back to it by name. A preset with the same name is overwritten. Turn the camera with camera_look first if it should point somewhere else.",
			parameters: {
				type: 'object',
				properties: {
					camera: CAMERA_PARAM,
					name: { type: 'string', description: 'The preset\'s name, e.g. "hallway".' }
				},
				required: ['camera', 'name']
			}
		}
	},
	displayLabel: (args) => `Save preset on ${String(args.camera ?? 'camera')}`,
	async execute(args, ctx) {
		const name = String(args.name ?? '').trim();
		if (!name) return toolResult(toolError(NAME_THE_PRESET));
		// Refused before asking: no point prompting for a camera without presets.
		const access = cameraAccessRefusal(ctx);
		const named = access ? null : resolveCamera(args.camera);
		if (named && !hasPresets(named)) return toolResult(toolError(NO_PRESETS));
		const gate = await cameraGate(ctx, args.camera, 'save_preset');
		if (!gate.camera) return refused(gate);
		const camera = gate.camera;
		let saved: CameraPresetSaved;
		try {
			saved = await withCameraActivity(camera.id, 'move', () =>
				invoke<CameraPresetSaved>('camera_preset_save', { config: camera, name })
			);
		} catch (e) {
			return toolResult(toolError(`${camera.name}: ${errorText(e)}`));
		}
		storePresets(camera.id, saved.presets);
		const list = saved.presets.map((p) => p.name).join(', ') || 'none';
		return toolResult(
			`${saved.replaced ? 'Replaced' : 'Saved'} the preset "${name}" on ${camera.name} where it points now. Its presets: ${list}.`
		);
	}
});

/** Whether the camera keeps presets: ONVIF pan/tilt, found over the network. */
function hasPresets(camera: CameraConfig): boolean {
	return camera.ptz === 'onvif' && canAim(camera);
}

/** Keep a camera's presets as read from it, as Refresh presets does. */
function storePresets(id: string, presets: CameraPresetSaved['presets']): void {
	setCameras(
		getSettings().cameras.map((c) =>
			c.id === id && c.onvif ? { ...c, onvif: { ...c.onvif, presets } } : c
		)
	);
}
