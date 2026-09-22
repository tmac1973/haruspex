/**
 * The backend for "nothing is configured".
 *
 * It exists so `resolveImageBackend()` always returns something and every
 * caller has one failure shape to handle. Its message is the whole of its
 * job: one sentence naming the settings path, per the project's UI-copy rule.
 */

import type { ImageBackend } from './backend';
import { ImageBackendError, type ImageBackendCapabilities } from './types';

const NOT_CONFIGURED = 'No image backend configured — Settings → Image.';

const NO_CAPABILITIES: ImageBackendCapabilities = {
	referenceConditioning: false,
	seamlessTiling: false,
	loras: false,
	maxLoras: 0
};

export const noneBackend: ImageBackend = {
	kind: 'none',
	capabilities: async () => ({ ...NO_CAPABILITIES }),
	probe: async () => ({ ok: false, detail: NOT_CONFIGURED }),
	generate: async () => {
		throw new ImageBackendError('unconfigured', NOT_CONFIGURED);
	}
};
