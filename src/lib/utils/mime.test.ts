import { describe, expect, it } from 'vitest';
import { extOf, imageMime } from './mime';

describe('extOf', () => {
	it('lowercases what follows the last dot', () => {
		expect(extOf('art/Sprite.Final.PNG')).toBe('png');
		expect(extOf('noext')).toBe('noext');
		expect(extOf('trailing.')).toBe('');
	});
});

describe('imageMime', () => {
	it('knows every image kind the viewer shows', () => {
		expect(imageMime('png')).toBe('image/png');
		expect(imageMime('jpg')).toBe('image/jpeg');
		expect(imageMime('jpeg')).toBe('image/jpeg');
		expect(imageMime('webp')).toBe('image/webp');
		expect(imageMime('gif')).toBe('image/gif');
		expect(imageMime('bmp')).toBe('image/bmp');
		expect(imageMime('svg')).toBe('image/svg+xml');
	});

	it('answers null for anything else, prototype names included', () => {
		expect(imageMime('txt')).toBeNull();
		expect(imageMime('')).toBeNull();
		expect(imageMime('constructor')).toBeNull();
		expect(imageMime('PNG')).toBeNull();
	});

	it('takes only the kinds a caller names', () => {
		expect(imageMime('webp', ['png', 'gif'])).toBeNull();
		expect(imageMime('gif', ['png', 'gif'])).toBe('image/gif');
	});
});
