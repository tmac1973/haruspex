import { describe, it, expect } from 'vitest';
import { onvifAddressFor } from './onvif';

describe('onvifAddressFor', () => {
	it('uses the RTSP host on the standard path', () => {
		expect(onvifAddressFor('rtsp://192.168.1.184:554/ch0')).toBe(
			'http://192.168.1.184/onvif/device_service'
		);
		expect(onvifAddressFor(' rtsp://cam.local/live ')).toBe(
			'http://cam.local/onvif/device_service'
		);
		expect(onvifAddressFor('rtsp://[fd00::5]:554/ch0')).toBe(
			'http://[fd00::5]/onvif/device_service'
		);
	});

	it('gives nothing for an address that is not RTSP', () => {
		expect(onvifAddressFor('')).toBeNull();
		expect(onvifAddressFor('http://192.168.1.5/')).toBeNull();
		expect(onvifAddressFor('not a url')).toBeNull();
	});
});
