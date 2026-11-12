/**
 * Network cameras' passwords, kept out of the settings under
 * `camera:<camera id>` (see `./accountSecrets`). The camera's RTSP source
 * carries only the key (`passwordRef`); Rust reads the password back when it
 * spawns ffmpeg and when it calls the camera's ONVIF service.
 */
import type { CameraConfig } from '#lib/ipc/gen/CameraConfig.ts';
import { accountSecrets } from '#lib/stores/accountSecrets.ts';

/** A camera as `accountSecrets` sees it: its password lifted out of the source. */
interface CameraAccount {
	id: string;
	password: string;
	passwordRef?: string;
}

function asAccount(camera: CameraConfig): CameraAccount {
	const ref = camera.source.kind === 'rtsp' ? camera.source.passwordRef : null;
	return { id: camera.id, password: '', passwordRef: ref ?? undefined };
}

// A camera's password was never stored inline, so there is nothing to migrate
// and the read/write pair `migrate` would use is empty.
const secrets = accountSecrets<CameraAccount>(
	'camera',
	() => [],
	() => {}
);

export function cameraSecretKey(cameraId: string): string {
	return secrets.key(cameraId);
}

/**
 * The camera as it should be stored with `password` kept in the secret store.
 * A USB camera has no password and comes back unchanged.
 */
export async function withStoredCameraPassword(
	camera: CameraConfig,
	password: string
): Promise<CameraConfig> {
	if (camera.source.kind !== 'rtsp') return camera;
	const { passwordRef } = await secrets.withStoredPassword(asAccount(camera), password);
	return { ...camera, source: { ...camera.source, passwordRef: passwordRef ?? null } };
}

/** Delete a camera's kept password. A failure is logged, never thrown. */
export function forgetCameraPassword(camera: CameraConfig): Promise<void> {
	return secrets.forget(asAccount(camera));
}
