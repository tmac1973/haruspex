"""Prototype: procedural, tileable, top-down pixel-art textures from a recipe.

Everything is periodic over the tile, so every texture tiles by construction.
"""
import json
import sys

import numpy as np
from PIL import Image

N = 32  # tile edge in pixels


def hexc(h):
    h = h.lstrip('#')
    return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], dtype=float)


# ---- periodic noise ---------------------------------------------------------

def value_noise(rng, cells):
    """Smooth value noise with `cells` lattice cells across the tile; wraps."""
    lat = rng.random((cells, cells))
    t = np.arange(N) * cells / N
    i0 = np.floor(t).astype(int)
    f = t - i0
    f = f * f * (3 - 2 * f)
    i1 = (i0 + 1) % cells
    i0 %= cells
    a = lat[np.ix_(i0, i0)]
    b = lat[np.ix_(i0, i1)]
    c = lat[np.ix_(i1, i0)]
    d = lat[np.ix_(i1, i1)]
    fx = f[None, :]
    fy = f[:, None]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def fbm(rng, cells, octaves=3):
    out = np.zeros((N, N))
    amp, tot = 1.0, 0.0
    for o in range(octaves):
        c = min(N, cells * 2 ** o)
        out += amp * value_noise(rng, c)
        tot += amp
        amp *= 0.5
    out /= tot
    return (out - out.min()) / (np.ptp(out) + 1e-9)


def worley(rng, cells):
    """Distances to nearest and second-nearest jittered point; wraps."""
    pts = []
    for gy in range(cells):
        for gx in range(cells):
            pts.append(((gx + rng.random()) * N / cells, (gy + rng.random()) * N / cells))
    pts = np.array(pts)
    yy, xx = np.mgrid[0:N, 0:N] + 0.5
    d = []
    for px, py in pts:
        dx = np.abs(xx - px)
        dy = np.abs(yy - py)
        dx = np.minimum(dx, N - dx)
        dy = np.minimum(dy, N - dy)
        d.append(np.sqrt(dx * dx + dy * dy))
    d = np.sort(np.stack(d), axis=0)
    return d[0], d[1]


BAYER = np.array([[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]) / 16.0


def ramp(field, colors, dither=True):
    """Map 0..1 to a palette ramp, ordered-dithered between steps."""
    cols = np.stack([hexc(c) for c in colors])
    k = len(cols) - 1
    v = np.clip(field, 0, 1) * k
    lo = np.floor(v).astype(int)
    frac = v - lo
    if dither:
        th = np.tile(BAYER, (N // 4, N // 4))
        lo = np.where(frac > th, lo + 1, lo)
    else:
        lo = np.where(frac > 0.5, lo + 1, lo)
    return cols[np.clip(lo, 0, k)]


# ---- layers -----------------------------------------------------------------

def lay_speckle(img, rng, L):
    m = rng.random((N, N)) < L.get('amount', 0.04)
    img[m] = hexc(L['color'])


def lay_cracks(img, rng, L):
    f1, f2 = worley(rng, L.get('cells', 3))
    edge = (f2 - f1) < L.get('width', 0.8)
    keep = fbm(rng, 2) > L.get('coverage', 0.45)
    img[edge & keep] = hexc(L['color'])


def lay_blotches(img, rng, L):
    f = fbm(rng, L.get('cells', 2), 2)
    img[f > L.get('threshold', 0.75)] = hexc(L['color'])


def bricks_mask(L):
    bw, bh, gap = L.get('w', 8), L.get('h', 4), L.get('gap', 1)
    yy, xx = np.mgrid[0:N, 0:N]
    row = yy // bh
    off = (row % 2) * (bw // 2) if L.get('offset', True) else 0
    col = (xx + off) // bw
    mortar = ((yy % bh) < gap) | (((xx + off) % bw) < gap)
    return mortar, row, col % (N // bw)


def lay_bricks(img, rng, L):
    mortar, row, col = bricks_mask(L)
    shades = [hexc(c) for c in L['colors']]
    ids = rng.integers(0, len(shades), size=(row.max() + 1, col.max() + 1))
    for y in range(N):
        for x in range(N):
            if not mortar[y, x]:
                img[y, x] = shades[ids[row[y, x], col[y, x]]] * 0.5 + img[y, x] * 0.5
    img[mortar] = hexc(L['mortar'])


def lay_stripes(img, rng, L):
    """Painted lines: axis x or y, at position, dashed or solid."""
    yy, xx = np.mgrid[0:N, 0:N]
    pos, w = L.get('pos', N // 2), L.get('width', 1)
    along = xx if L.get('axis', 'x') == 'x' else yy
    across = yy if L.get('axis', 'x') == 'x' else xx
    m = (across >= pos) & (across < pos + w)
    if L.get('dash'):
        on, off = L['dash']
        m &= (along % (on + off)) < on
    wear = rng.random((N, N)) < L.get('wear', 0.0)
    img[m & ~wear] = hexc(L['color'])


def lay_waves(img, rng, L):
    yy, xx = np.mgrid[0:N, 0:N]
    phase = fbm(rng, 2, 2) * 2 * np.pi
    s = np.sin(2 * np.pi * (yy * L.get('freq', 4) / N) + phase)
    img[s > L.get('threshold', 0.92)] = hexc(L['color'])


def lay_grid(img, rng, L):
    yy, xx = np.mgrid[0:N, 0:N]
    step, w = L.get('step', 8), L.get('width', 1)
    m = ((yy % step) < w) | ((xx % step) < w)
    img[m] = hexc(L['color'])


def lay_bevel(img, rng, L):
    """Light top/left and dark bottom/right edge on each grid cell."""
    yy, xx = np.mgrid[0:N, 0:N]
    step = L.get('step', 8)
    img[(yy % step) == 1] = hexc(L['light'])
    img[(xx % step) == 1] = hexc(L['light'])
    img[(yy % step) == step - 1] = hexc(L['dark'])
    img[(xx % step) == step - 1] = hexc(L['dark'])


LAYERS = {
    'speckle': lay_speckle, 'cracks': lay_cracks, 'blotches': lay_blotches,
    'bricks': lay_bricks, 'stripes': lay_stripes, 'waves': lay_waves,
    'grid': lay_grid, 'bevel': lay_bevel,
}


def render(recipe, seed=1):
    rng = np.random.default_rng(seed)
    b = recipe['base']
    img = ramp(fbm(rng, b.get('cells', 4), b.get('octaves', 3)), b['ramp'], b.get('dither', True))
    for L in recipe.get('layers', []):
        LAYERS[L['type']](img, rng, L)
    return Image.fromarray(img.astype(np.uint8), 'RGB')


if __name__ == '__main__':
    recipes = json.load(open(sys.argv[1]))
    S = 8
    t = N * S
    cols = 6
    rows = (len(recipes) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * (t * 2 + 12), rows * (t * 2 + 12)), (40, 40, 40))
    for i, (name, r) in enumerate(recipes.items()):
        im = render(r).resize((t, t), Image.NEAREST)
        im.save(f'tex_{name}.png')
        for x in (0, t):
            for y in (0, t):
                sheet.paste(im, ((i % cols) * (t * 2 + 12) + x, (i // cols) * (t * 2 + 12) + y))
    sheet.save(sys.argv[2])
