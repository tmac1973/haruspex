/**
 * Seeded randomness for build modules (`check_3d`'s kit): the same seed draws
 * the same rock, bark or terrain every run, so an asset can be rebuilt and
 * compared. `random` is mulberry32; `createNoise` is 2D/3D simplex noise.
 */

/** A seeded generator of numbers in [0, 1). */
export function random(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const GRAD3 = [
	[1, 1, 0],
	[-1, 1, 0],
	[1, -1, 0],
	[-1, -1, 0],
	[1, 0, 1],
	[-1, 0, 1],
	[1, 0, -1],
	[-1, 0, -1],
	[0, 1, 1],
	[0, -1, 1],
	[0, 1, -1],
	[0, -1, -1]
];

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const F3 = 1 / 3;
const G3 = 1 / 6;

export interface Noise {
	/** Smooth noise in [-1, 1]. */
	noise2(x: number, y: number): number;
	noise3(x: number, y: number, z: number): number;
}

/** Simplex noise, its permutation shuffled from `seed`. */
export function createNoise(seed: number): Noise {
	const rand = random(seed);
	const p = Array.from({ length: 256 }, (_, i) => i);
	for (let i = 255; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[p[i], p[j]] = [p[j], p[i]];
	}
	const perm = new Uint8Array(512);
	for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
	const g = (i: number) => GRAD3[perm[i] % 12];

	function corner2(x: number, y: number, gi: number): number {
		const t = 0.5 - x * x - y * y;
		if (t < 0) return 0;
		const gr = g(gi);
		return t * t * t * t * (gr[0] * x + gr[1] * y);
	}

	function corner3(x: number, y: number, z: number, gi: number): number {
		const t = 0.6 - x * x - y * y - z * z;
		if (t < 0) return 0;
		const gr = g(gi);
		return t * t * t * t * (gr[0] * x + gr[1] * y + gr[2] * z);
	}

	function noise2(xin: number, yin: number): number {
		const s = (xin + yin) * F2;
		const i = Math.floor(xin + s);
		const j = Math.floor(yin + s);
		const t = (i + j) * G2;
		const x0 = xin - (i - t);
		const y0 = yin - (j - t);
		const [i1, j1] = x0 > y0 ? [1, 0] : [0, 1];
		const ii = i & 255;
		const jj = j & 255;
		const n =
			corner2(x0, y0, ii + perm[jj]) +
			corner2(x0 - i1 + G2, y0 - j1 + G2, ii + i1 + perm[jj + j1]) +
			corner2(x0 - 1 + 2 * G2, y0 - 1 + 2 * G2, ii + 1 + perm[jj + 1]);
		return 70 * n;
	}

	function order3(x0: number, y0: number, z0: number): number[] {
		if (x0 >= y0) {
			if (y0 >= z0) return [1, 0, 0, 1, 1, 0];
			if (x0 >= z0) return [1, 0, 0, 1, 0, 1];
			return [0, 0, 1, 1, 0, 1];
		}
		if (y0 < z0) return [0, 0, 1, 0, 1, 1];
		if (x0 < z0) return [0, 1, 0, 0, 1, 1];
		return [0, 1, 0, 1, 1, 0];
	}

	function noise3(xin: number, yin: number, zin: number): number {
		const s = (xin + yin + zin) * F3;
		const i = Math.floor(xin + s);
		const j = Math.floor(yin + s);
		const k = Math.floor(zin + s);
		const t = (i + j + k) * G3;
		const x0 = xin - (i - t);
		const y0 = yin - (j - t);
		const z0 = zin - (k - t);
		const [i1, j1, k1, i2, j2, k2] = order3(x0, y0, z0);
		const ii = i & 255;
		const jj = j & 255;
		const kk = k & 255;
		const n =
			corner3(x0, y0, z0, ii + perm[jj + perm[kk]]) +
			corner3(x0 - i1 + G3, y0 - j1 + G3, z0 - k1 + G3, ii + i1 + perm[jj + j1 + perm[kk + k1]]) +
			corner3(
				x0 - i2 + 2 * G3,
				y0 - j2 + 2 * G3,
				z0 - k2 + 2 * G3,
				ii + i2 + perm[jj + j2 + perm[kk + k2]]
			) +
			corner3(
				x0 - 1 + 3 * G3,
				y0 - 1 + 3 * G3,
				z0 - 1 + 3 * G3,
				ii + 1 + perm[jj + 1 + perm[kk + 1]]
			);
		return 32 * n;
	}

	return { noise2, noise3 };
}
