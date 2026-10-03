import { describe, it, expect } from 'vitest';
import { engineSetupMessage } from './backend';

describe('engineSetupMessage', () => {
	it('says what is missing and what to do, not just a fragment', () => {
		// The Rust detail for a missing engine is "sd-server"; that alone was
		// what the user saw.
		expect(engineSetupMessage('SidecarMissing', 'sd-server')).toBe(
			'The bundled image engine is missing (sd-server). Reinstall Haruspex, or in a ' +
				'development checkout run ./scripts/fetch-sdcpp.sh.'
		);
		expect(engineSetupMessage('ModelMissing', '/m/sd15.safetensors')).toMatch(
			/not on disk \(\/m\/sd15\.safetensors\) — download it again in Settings → Image/
		);
		expect(engineSetupMessage('NoModel', '')).toMatch(/Settings → Image/);
	});

	it('leaves the failures that are not set-up to the caller', () => {
		expect(engineSetupMessage('Timeout', 'no answer')).toBeNull();
		expect(engineSetupMessage(undefined, 'boom')).toBeNull();
	});
});
