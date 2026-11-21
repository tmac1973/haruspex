/**
 * The camera digest's settings, and whether one can run at all: it needs a
 * camera set to Allow, and a model the cameras may be shown to.
 */
import type { BackendOverride } from '#lib/api.ts';
import type { CameraConfig } from '#lib/ipc/gen/CameraConfig.ts';
import { cameraDataAllowed } from '#lib/camera/trust.ts';
import { resolveBackendDescriptor } from '#lib/inference/descriptor.ts';
import { getSettings } from '#lib/stores/settings.ts';

export type DigestPeriod = 'since_last_run' | 'last_24h' | 'today';

export const PERIODS: readonly DigestPeriod[] = ['since_last_run', 'last_24h', 'today'];

export interface CameraDigestConfig {
	/** Camera ids (Settings → Cameras); empty means every camera set to Allow. */
	cameras: string[];
	/** What to summarise. `since_last_run` reads the last 24 h on a first run. */
	period: DigestPeriod;
	/** Take a fresh picture from each camera as well. */
	include_snapshot: boolean;
	/** What to pay attention to, in the user's words; may be blank. */
	focus: string;
	/** Email the result to Settings → Cameras → Alerts' addresses. */
	email_result: boolean;
}

export const FOCUS_MAX = 500;

export const NEEDS =
	'Needs a camera set to Allow in Settings → Cameras, and a local or trusted model.';

export function cameraDigestDefaults(): CameraDigestConfig {
	return {
		cameras: [],
		period: 'since_last_run',
		include_snapshot: false,
		focus: '',
		email_result: false
	};
}

/** The config stored on a job; anything missing or malformed takes its default. */
export function parseCameraDigestConfig(typeConfig: string | null): CameraDigestConfig {
	const out = cameraDigestDefaults();
	if (!typeConfig) return out;
	try {
		const raw = JSON.parse(typeConfig) as Partial<CameraDigestConfig>;
		if (Array.isArray(raw.cameras)) {
			out.cameras = raw.cameras.filter((id): id is string => typeof id === 'string');
		}
		if (PERIODS.includes(raw.period as DigestPeriod)) out.period = raw.period as DigestPeriod;
		if (typeof raw.include_snapshot === 'boolean') out.include_snapshot = raw.include_snapshot;
		if (typeof raw.focus === 'string') out.focus = raw.focus;
		if (typeof raw.email_result === 'boolean') out.email_result = raw.email_result;
	} catch {
		// A config that doesn't parse runs on the defaults, and the editor shows them.
	}
	return out;
}

export function cameraDigestConfigToJson(c: CameraDigestConfig): string {
	return JSON.stringify({
		cameras: c.cameras,
		period: c.period,
		include_snapshot: c.include_snapshot,
		focus: c.focus.trim(),
		email_result: c.email_result
	});
}

/** Save-time check; the error to show, or null. */
export function validateCameraDigest(c: CameraDigestConfig): string | null {
	if (!PERIODS.includes(c.period)) return 'Choose a period.';
	if (c.focus.trim().length > FOCUS_MAX) return `Keep the focus under ${FOCUS_MAX} characters.`;
	return null;
}

/** The cameras set to Allow. */
export function allowCameras(
	cameras: readonly CameraConfig[] = getSettings().cameras
): CameraConfig[] {
	return cameras.filter((c) => c.permission === 'allow');
}

/**
 * Whether a digest on the model `backend` names (undefined: Settings) can run:
 * a camera is set to Allow, and that model may be shown the cameras — the
 * same check the camera tools make on the job's turns.
 */
export function cameraDigestUsable(backend?: BackendOverride): boolean {
	return allowCameras().length > 0 && cameraDataAllowed(resolveBackendDescriptor(backend));
}
