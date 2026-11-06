#!/usr/bin/env python3
"""Apply Course Check-in Assistant branding to the pinned upstream Android app.

This patch changes launcher art + user-facing copy. It retains the original
application ID, source attribution, license, and protocol identifiers.
"""
from pathlib import Path
import sys
import cairosvg

root = Path(sys.argv[1]).resolve()
resources = root / "app/src/main/res"
code = root / "app/src/main/java"
source = Path(__file__).with_name("course_assistant_icon.svg")

app_name = resources / "values/strings.xml"
assert app_name.is_file(), app_name
xml = app_name.read_text(encoding="utf-8")
old = '<string name="app_name">随地大小签</string>'
new = '<string name="app_name">课程签到助手</string>'
assert xml.count(old) == 1, "Unexpected app label"
app_name.write_text(xml.replace(old, new), encoding="utf-8")

# Existing app uses standard raster launcher resources for five densities.
for density, size in {
    "mdpi": 48,
    "hdpi": 72,
    "xhdpi": 96,
    "xxhdpi": 144,
    "xxxhdpi": 192,
}.items():
    path = resources / f"mipmap-{density}/ic_launcher.png"
    assert path.is_file(), f"Missing launcher asset: {path}"
    cairosvg.svg2png(
        url=str(source),
        write_to=str(path),
        output_width=size,
        output_height=size,
    )
    assert path.stat().st_size > 100, path
    print("Launcher icon:", density, size, path.stat().st_size)

# Replace only user-visible copy, never package IDs, deep links or protocols.
files = 0
for path in code.rglob("*.kt"):
    text = path.read_text(encoding="utf-8")
    if "随地大小签" in text:
        path.write_text(text.replace("随地大小签", "课程签到助手"), encoding="utf-8")
        files += 1

manifest = (root / "app/src/main/AndroidManifest.xml").read_text(encoding="utf-8")
assert 'android:label="@string/app_name"' in manifest
assert 'android:icon="@mipmap/ic_launcher"' in manifest
assert 'android.intent.category.LAUNCHER' in manifest
print(f"SUCCESS: launcher name and icons updated; in-app copy files: {files}")
