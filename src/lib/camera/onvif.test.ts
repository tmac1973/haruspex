import { describe, it, expect } from 'vitest';
import { hostOf, onvifAddressFor, withHost } from './onvif';

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

describe('withHost', () => {
	it('swaps the address for the name and keeps the rest', () => {
		expect(withHost('rtsp://192.168.1.184:554/ch0', '192.168.1.184', 'cam.home.internal')).toBe(
			'rtsp://cam.home.internal:554/ch0'
		);
		expect(
			withHost('http://192.168.1.184/onvif/device_service', '192.168.1.184', 'cam.local')
		).toBe('http://cam.local/onvif/device_service');
		expect(withHost('rtsp://u:p@192.168.1.184/ch1', '192.168.1.184', 'cam.local')).toBe(
			'rtsp://u:p@cam.local/ch1'
		);
	});

	it('leaves an address on another host alone', () => {
		expect(withHost('rtsp://192.168.1.18/ch0', '192.168.1.184', 'cam.local')).toBe(
			'rtsp://192.168.1.18/ch0'
		);
		expect(withHost('', '192.168.1.184', 'cam.local')).toBe('');
	});

	it('reads the host', () => {
		expect(hostOf('http://192.168.1.184/onvif/device_service')).toBe('192.168.1.184');
		expect(hostOf('rtsp://u:p@cam.local:554/ch0')).toBe('cam.local');
		expect(hostOf('nope')).toBe('');
	});
});
