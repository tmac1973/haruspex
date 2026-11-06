import { describe, expect, it } from 'vitest';
import {
	finiteOrNull,
	finiteOrUndefined,
	nonEmptyOrNull,
	numberOrNaN,
	parsedFiniteOrNull,
	parsedOrNaN,
	stringOr,
	trimmed,
	trimmedOrNull
} from './coerce';

describe('string coercers', () => {
	it('stringOr keeps a string as it is, blank too, and falls back otherwise', () => {
		expect(stringOr(' a ')).toBe(' a ');
		expect(stringOr('')).toBe('');
		expect(stringOr(3)).toBe('');
		expect(stringOr(null, 'x')).toBe('x');
	});

	it('trimmed trims, and gives "" for anything else', () => {
		expect(trimmed('  a b ')).toBe('a b');
		expect(trimmed(7)).toBe('');
		expect(trimmed(undefined)).toBe('');
	});

	it('trimmedOrNull trims, and gives null for blank or not a string', () => {
		expect(trimmedOrNull(' a ')).toBe('a');
		expect(trimmedOrNull('   ')).toBeNull();
		expect(trimmedOrNull(1)).toBeNull();
	});

	it('nonEmptyOrNull keeps whitespace, and gives null only for "" or not a string', () => {
		expect(nonEmptyOrNull(' ')).toBe(' ');
		expect(nonEmptyOrNull('')).toBeNull();
		expect(nonEmptyOrNull(false)).toBeNull();
	});
});

describe('number coercers', () => {
	it('finiteOrNull and finiteOrUndefined take finite numbers only, never strings', () => {
		expect(finiteOrNull(2.5)).toBe(2.5);
		expect(finiteOrNull(Infinity)).toBeNull();
		expect(finiteOrNull('3')).toBeNull();
		expect(finiteOrUndefined(0)).toBe(0);
		expect(finiteOrUndefined(NaN)).toBeUndefined();
		expect(finiteOrUndefined('3')).toBeUndefined();
	});

	it('parsedFiniteOrNull parses a non-blank string', () => {
		expect(parsedFiniteOrNull(' 4 ')).toBe(4);
		expect(parsedFiniteOrNull(5)).toBe(5);
		expect(parsedFiniteOrNull('')).toBeNull();
		expect(parsedFiniteOrNull('  ')).toBeNull();
		expect(parsedFiniteOrNull('x')).toBeNull();
		expect(parsedFiniteOrNull(Infinity)).toBeNull();
	});

	it('numberOrNaN passes any number through, and never parses', () => {
		expect(numberOrNaN(Infinity)).toBe(Infinity);
		expect(numberOrNaN(1)).toBe(1);
		expect(numberOrNaN('1')).toBeNaN();
		expect(numberOrNaN(undefined)).toBeNaN();
	});

	it('parsedOrNaN parses strings with Number, so a blank one is 0', () => {
		expect(parsedOrNaN(Infinity)).toBe(Infinity);
		expect(parsedOrNaN('2.5')).toBe(2.5);
		expect(parsedOrNaN('')).toBe(0);
		expect(parsedOrNaN('Infinity')).toBeNaN();
		expect(parsedOrNaN('abc')).toBeNaN();
		expect(parsedOrNaN(null)).toBeNaN();
	});
});
