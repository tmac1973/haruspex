import { describe, it, expect } from 'vitest';
import { errorBody, errorText, urlForReport, urlHost } from './http';

describe('errorBody', () => {
	it('reads an OpenAI-style message and code', () => {
		expect(errorBody('{"error":{"message":"no model","code":"not_ready"}}')).toEqual({
			message: 'no model',
			code: 'not_ready'
		});
	});

	it('answers nulls for a body that is not JSON, has no error, or empty fields', () => {
		const none = { message: null, code: null };
		expect(errorBody('<html>502</html>')).toEqual(none);
		expect(errorBody('')).toEqual(none);
		expect(errorBody('{"ok":true}')).toEqual(none);
		expect(errorBody('{"error":{"message":"","code":7}}')).toEqual(none);
		expect(errorBody('null')).toEqual(none);
	});

	it('does not take a bare error string for a message', () => {
		expect(errorBody('{"error":"busy"}')).toEqual({ message: null, code: null });
	});
});

describe('errorText', () => {
	it('reads a bare error string', () => {
		expect(errorText('{"error":"no such job"}')).toBe('no such job');
	});

	it('answers null for anything else', () => {
		expect(errorText('{"error":{"message":"x"}}')).toBeNull();
		expect(errorText('{"error":""}')).toBeNull();
		expect(errorText('[1]')).toBeNull();
		expect(errorText('null')).toBeNull();
		expect(errorText('oops')).toBeNull();
	});
});

describe('urlHost', () => {
	it('names the host with its port', () => {
		expect(urlHost('http://gpu.lan:8080/v1')).toBe('gpu.lan:8080');
		expect(urlHost('https://example.com')).toBe('example.com');
	});

	it('answers null for no URL, or one without a host', () => {
		expect(urlHost('not a url')).toBeNull();
		expect(urlHost('file:///tmp/x')).toBeNull();
	});
});

describe('urlForReport', () => {
	it('drops userinfo, query and fragment', () => {
		expect(urlForReport('http://u:p@host:8080/v1?key=s#x')).toBe('http://host:8080/v1');
	});
});
