import { describe, it, expect } from 'vitest';
import { artifactUrl } from './artifactUrl';

describe('artifactUrl', () => {
	it('uses the native scheme on Linux and macOS', () => {
		expect(artifactUrl('ab12', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit')).toBe(
			'haruspex-artifact://localhost/ab12'
		);
	});

	it('uses the localhost form on Windows', () => {
		expect(artifactUrl('ab12', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(
			'http://haruspex-artifact.localhost/ab12'
		);
	});
});
