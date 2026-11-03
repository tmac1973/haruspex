import { describe, expect, it } from 'vitest';
import { textureRefs, texturePath } from './textures';

describe('textureRefs', () => {
	it('finds single- and double-quoted literals, each once, in order', () => {
		const src = `const a = kit.texture('bark.png');
const b = kit.texture( "tex/leaf.png" );
const c = kit.texture('bark.png');`;
		expect(textureRefs(src)).toEqual(['bark.png', 'tex/leaf.png']);
	});

	it('ignores template strings, variables and mismatched quotes', () => {
		const src =
			'kit.texture(`a.png`); kit.texture(name); kit.texture(\'b.png"); kit.texture("c.png" + x);';
		expect(textureRefs(src)).toEqual([]);
	});
});

describe('texturePath', () => {
	it('joins the path to the module folder and folds . and ..', () => {
		expect(texturePath('m', 'tex/./wood.png')).toBe('m/tex/wood.png');
		expect(texturePath('m/a', '../b.png')).toBe('m/b.png');
		expect(texturePath('', 'b.png')).toBe('b.png');
		expect(texturePath('/proj/m', '../b.png')).toBe('/proj/b.png');
	});

	it('refuses an absolute path and one that climbs out of the top', () => {
		expect(texturePath('m', '/etc/x.png')).toBeNull();
		expect(texturePath('m', 'C:\\x.png')).toBeNull();
		expect(texturePath('m', '../../x.png')).toBeNull();
		expect(texturePath('', '../x.png')).toBeNull();
	});
});
