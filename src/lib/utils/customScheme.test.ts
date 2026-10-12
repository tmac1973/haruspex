import { describe, expect, it } from 'vitest';
import { customSchemeBase } from './customScheme';

describe('customSchemeBase', () => {
	it('uses the http://<scheme>.localhost form on Windows', () => {
		expect(customSchemeBase('haruspex-img', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(
			'http://haruspex-img.localhost/'
		);
	});

	it('uses the http://<scheme>.localhost form on Android', () => {
		expect(customSchemeBase('haruspexfetch', 'Mozilla/5.0 (Linux; Android 14)')).toBe(
			'http://haruspexfetch.localhost/'
		);
	});

	it('uses the native <scheme>://localhost form on Linux and macOS', () => {
		expect(customSchemeBase('haruspex-img', 'Mozilla/5.0 (X11; Linux x86_64)')).toBe(
			'haruspex-img://localhost/'
		);
		expect(customSchemeBase('haruspex-img', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')).toBe(
			'haruspex-img://localhost/'
		);
	});
});
