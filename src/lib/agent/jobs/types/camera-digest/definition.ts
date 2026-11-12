import type { JobTypeDefinition } from '#lib/agent/jobs/types/types.ts';
import Editor from '#lib/agent/jobs/types/camera-digest/Editor.svelte';
import {
	allowCameras,
	cameraDigestConfigToJson,
	cameraDigestDefaults,
	cameraDigestUsable,
	parseCameraDigestConfig,
	validateCameraDigest,
	type CameraDigestConfig
} from '#lib/agent/jobs/types/camera-digest/config.ts';
import {
	planCameraDigestSteps,
	runCameraDigestPipeline
} from '#lib/agent/jobs/types/camera-digest/pipeline.ts';
import { getSettings } from '#lib/stores/settings.ts';

export const cameraDigestJobType: JobTypeDefinition = {
	id: 'camera_digest',
	label: 'Camera digest',
	description: 'Summarises what your cameras’ ambient logs recorded, on a schedule.',
	badgeLabel: 'camera',
	hasPlannedSteps: false,
	supportsSchedule: true,
	background: true,
	// Not knowing which job is asking, this answers for the Settings model, or
	// any server trusted in Settings → Cameras that a job might be pointed at.
	// Each run checks its own model before it reads anything.
	available: async () =>
		cameraDigestUsable() ||
		(allowCameras().length > 0 && getSettings().cameraTrustedServers.length > 0),
	Editor,
	configDefaults: () => ({ ...cameraDigestDefaults() }),
	configFromJob: (typeConfig) => ({ ...parseCameraDigestConfig(typeConfig) }),
	configToJson: (config) => cameraDigestConfigToJson(config as unknown as CameraDigestConfig),
	validate: (input) => validateCameraDigest(input.config as unknown as CameraDigestConfig),
	persistSteps: () => [],
	planSteps: planCameraDigestSteps,
	runPipeline: runCameraDigestPipeline
};
