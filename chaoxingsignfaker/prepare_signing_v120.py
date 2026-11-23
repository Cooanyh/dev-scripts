#!/usr/bin/env python3
"""Configure independent release signing only with explicit GitHub Actions Secrets.

Required env:
  STUDYHELPER_KEYSTORE_BASE64
  STUDYHELPER_KEYSTORE_PASSWORD

Never upload the keystore to git or OSS. Never print secret values.
"""
import base64
import os
from pathlib import Path
import sys

root=Path(sys.argv[1]).resolve()
encoded=os.getenv("STUDYHELPER_KEYSTORE_BASE64","")
password=os.getenv("STUDYHELPER_KEYSTORE_PASSWORD","")
if not encoded or not password:
    print("No stable signer configured; debug PREVIEW only. OTA publication is disabled.")
    (root/"studyhelper_signing_mode.txt").write_text("preview\n")
    raise SystemExit(0)

keystore=Path(os.environ["RUNNER_TEMP"])/"studyhelper-release.p12"
try:
    keystore.write_bytes(base64.b64decode(encoded,validate=True))
    os.chmod(keystore,0o600)
    assert keystore.stat().st_size>500
except Exception:
    keystore.unlink(missing_ok=True)
    raise RuntimeError("Invalid signing keystore secret")

gradle=root/"app/build.gradle"
s=gradle.read_text(encoding="utf-8")
assert "    signingConfigs {" not in s, "Unexpected signingConfig from upstream"
marker='    buildTypes {\n'
assert marker in s and "        release {\n" in s
conf='''    signingConfigs {
        register("corenRelease") {
            storeFile file(System.getenv("STUDYHELPER_SIGNING_KEYSTORE_FILE"))
            storePassword System.getenv("STUDYHELPER_KEYSTORE_PASSWORD")
            keyAlias "studyhelper"
            keyPassword System.getenv("STUDYHELPER_KEYSTORE_PASSWORD")
            storeType "PKCS12"
        }
    }
'''
s=s.replace(marker,conf+marker,1)
s=s.replace('        release {\n','        release {\n            signingConfig signingConfigs.corenRelease\n',1)
gradle.write_text(s,encoding="utf-8")
(root/"studyhelper_signing_mode.txt").write_text("signed\n")
print("Stable keystore present. Build will use independently signed release APK.")
