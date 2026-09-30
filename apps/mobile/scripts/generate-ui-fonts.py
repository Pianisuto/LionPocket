"""Run from repo root with fonttools + brotli. Sources are the desktop fonts."""
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
out = Path('apps/mobile/android/app/src/main/assets/fonts')
out.mkdir(parents=True, exist_ok=True)
for family, source, weights in [
    ('Inter', 'inter', [('Regular', 400), ('Medium', 500), ('SemiBold', 600)]),
    ('BricolageGrotesque', 'bricolage-grotesque', [('Bold', 700)])
]:
    for suffix, weight in weights:
        font = TTFont(f'node_modules/@fontsource-variable/{source}/files/{source}-latin-wght-normal.woff2')
        axes = {axis.axisTag: weight if axis.axisTag == 'wght' else axis.defaultValue for axis in font['fvar'].axes}
        font = instantiateVariableFont(font, axes, inplace=True)
        font.flavor = None
        font.save(out / f'{family}-{suffix}.ttf')
