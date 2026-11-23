#!/usr/bin/env python3
"""Create a complete OSS upload bundle for StudyHelper v1.20.0-coren1."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import shutil
import sys
import zipfile

root=Path(sys.argv[1]).resolve()
mode=(root/"studyhelper_signing_mode.txt").read_text().strip()
assert mode in ("signed","preview")
apk_source=root/"app/build/outputs/apk"/("release/app-release.apk" if mode=="signed" else "debug/app-debug.apk")
assert apk_source.is_file(),f"Missing {apk_source}"
dist=Path(sys.argv[2]).resolve()
target=dist/"software/update/studyhelper"
target.mkdir(parents=True,exist_ok=True)
name="StudyHelper-1.20.0-coren1.apk" if mode=="signed" else "StudyHelper-1.20.0-coren1-PREVIEW-DEBUG.apk"
dest=target/name
shutil.copyfile(apk_source,dest)
digest=hashlib.sha256(dest.read_bytes()).hexdigest()
size=dest.stat().st_size
released=int(datetime.now(timezone.utc).timestamp()*1000)
base_url="https://static.coren.xin"
object_key=f"software/update/studyhelper/{name}"
version={
    "packageName":"org.aquamarine5.brainspark.chaoxingsignfaker",
    "versionCode":120001121,
    "versionName":"1.20.0-coren1",
    "releaseDate":released,
    "changelog":"课程签到助手 1.20.0-coren1：\n1. 同步上游 1.20.0-stable，更新底层学习通接口。\n2. 保留并完善去友盟、品牌图标及本地签到统计。\n3. 新增维护版 OSS 更新源，优先于只读原作者更新提醒。\n4. 下载 APK 时验证 SHA-256、包名和版本号。\n\n非官方构建，原作者版本仍作为只读信息源；不同签名不可互相覆盖。",
    "forceInstall":False,
    "forceInstallLessVersion":0,
    "possibleDownloadPath":[
      {"authority":"org.aquamarine5.brainspark.stackbricks.downloadpath.cloudflare",
       "filename":name,
       "additionalInformation":{
           "baseUrl":base_url,
           "objectKey":object_key,
           "sha256":digest,
           "sizeBytes":size
       }}
    ]
}
manifest={"manifestVersion":4,"latestStable":version,"latestTest":version}
(target/"stackbricks_manifest.json").write_text(
    json.dumps(manifest,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
(target/"SHA256SUMS.txt").write_text(f"{digest}  {name}\n",encoding="utf-8")
source_url="https://github.com/Cooanyh/dev-scripts/tree/build/studyhelper-v120-oss-20261123/chaoxingsignfaker"
(target/"SOURCE_AND_LICENSE.txt").write_text(
    "Unofficial AGPL-3.0 modified build of aquamarine5/ChaoxingSignFaker.\n"
    "Upstream source: https://github.com/aquamarine5/ChaoxingSignFaker\n"
    "Upstream pinned commit: 24fe193d03d2140d572eea3e58d27f7868504dcb\n"
    "Corresponding modification scripts and build workflow:\n"+source_url+"\n"
    "Not endorsed by the original author. No warranty.\n",encoding="utf-8")
readme=f"""课程签到助手 · OSS 部署说明
=================================

重要：本次构建类型 = {mode.upper()}
{"可用于维护版正式 OTA 更新，前提是后续版本一直使用同一签名私钥。" if mode=="signed" else "⚠ 调试版仅供测试，不要将此预览包部署到正式 OSS 更新通道。每次 CI 的调试签名可能不同，未来无法覆盖升级。请先设置 GitHub Actions Secrets 再运行正式构建。"}

目标根目录（域名）: {base_url}/
上传时保留相对路径：
  software/update/studyhelper/{name}
  software/update/studyhelper/stackbricks_manifest.json
  software/update/studyhelper/SHA256SUMS.txt
  software/update/studyhelper/SOURCE_AND_LICENSE.txt

在线预期地址：
  {base_url}/software/update/studyhelper/stackbricks_manifest.json
  {base_url}/{object_key}

SHA-256: {digest}
APK bytes: {size}
Package: org.aquamarine5.brainspark.chaoxingsignfaker
Version code: 120001121

上传顺序：
1. 先上传 APK、SHA256SUMS.txt 与 SOURCE_AND_LICENSE.txt。
2. 验证 APK URL HTTP 200、Content-Length 和 SHA256。
3. 最后原子替换 stackbricks_manifest.json。
4. manifest 设 Content-Type: application/json; charset=utf-8；Cache-Control: public, max-age=300。
5. APK 设 Content-Type: application/vnd.android.package-archive；
   文件名版本化，可设置 Cache-Control: public, max-age=31536000, immutable。
6. 必须 HTTPS，不能返回网页拦截页或反盗链错误。

注意：不要上传私钥 *.p12、GitHub Secrets 内容。
注意：软件本身仍包含 Sentry/Supabase 等服务，未宣称零遥测。
"""
(target/"README-OSS.txt").write_text(readme,encoding="utf-8")
bundle=dist/("StudyHelper-OSS-READY-1.20.0-coren1.zip" if mode=="signed"
             else "StudyHelper-OSS-PREVIEW-DO-NOT-UPLOAD.zip")
with zipfile.ZipFile(bundle,"w",compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for p in target.rglob("*"):
        if p.is_file(): z.write(p,p.relative_to(dist))
print(json.dumps({"mode":mode,"apk":str(dest),"sha256":digest,
                  "ossBundle":str(bundle),"size":size},ensure_ascii=False))
