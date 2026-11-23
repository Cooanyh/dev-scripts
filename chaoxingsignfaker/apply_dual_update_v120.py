#!/usr/bin/env python3
"""Apply two-channel update UI to current ChaoxingSignFaker source.

OSS channel is installable and first. Official Stackbricks feed remains available
as a read-only informational channel: upstream releases have a *different
certificate* and cannot safely be installed over this independently signed fork.
"""
from pathlib import Path
import sys

root=Path(sys.argv[1]).resolve()
pkg=root/"app/src/main/java/org/aquamarine5/brainspark/chaoxingsignfaker"
settings=pkg/"screen/SettingScreen.kt"
s=settings.read_text(encoding="utf-8")
for insertion in [
"import org.aquamarine5.brainspark.stackbricks.StackbricksPolicy",
"import org.aquamarine5.brainspark.stackbricks.rememberStackbricksStatus",
"import org.aquamarine5.brainspark.stackbricks.providers.cloudflare.CloudflareConfiguration",
"import org.aquamarine5.brainspark.stackbricks.providers.cloudflare.CloudflareMessageProvider",
"import org.aquamarine5.brainspark.stackbricks.providers.cloudflare.CloudflarePackageProvider",
"import org.aquamarine5.brainspark.chaoxingsignfaker.utilities.OssCheckedPackageProvider",
"import okhttp3.OkHttpClient",
"import kotlinx.coroutines.withContext",
]:
    assert insertion not in s, "already modified: "+insertion
    marker="import org.aquamarine5.brainspark.stackbricks.StackbricksService\n"
    assert marker in s
    s=s.replace(marker,marker+insertion+"\n")
start=s.index("        StackbricksComponent(\n            stackbricksService,")
end=s.index("        Spacer(modifier = Modifier.height(8.dp))",start)

new_block='''        // Community OSS first; never silently replace the signed community APK
        // with the differently signed official APK.
        val communityStatus = rememberStackbricksStatus()
        val communityConfiguration = remember {
            CloudflareConfiguration(
                possibleConfigurations = listOf(
                    "static.coren.xin" to "software/update/studyhelper/stackbricks_manifest.json"
                ),
                defaultBaseUrl = "https://static.coren.xin",
                okHttpClient = OkHttpClient.Builder()
                    .callTimeout(60, java.util.concurrent.TimeUnit.SECONDS)
                    .build(),
            )
        }
        val communityService = remember {
            StackbricksService(
                context,
                possibleMessageProvider = listOf(
                    CloudflareMessageProvider(communityConfiguration)
                ),
                possiblePackageProvider = listOf(
                    OssCheckedPackageProvider(CloudflarePackageProvider(communityConfiguration))
                ),
                state = communityStatus,
                stackbricksPolicy = StackbricksPolicy(
                    versionName = BuildConfig.VERSION_NAME,
                    isAllowedToDisableCheckUpdateOnLaunch = true,
                    isForceInstallValueCallback = false,
                )
            )
        }
        Text("课程签到助手 · 维护版更新（优先）", fontWeight = FontWeight.Bold)
        Text(
            "更新清单来自 static.coren.xin。下载时会校验 SHA-256、包名及版本号。",
            fontSize = 12.sp,
        )
        Spacer(modifier = Modifier.height(8.dp))
        StackbricksComponent(communityService)
        Spacer(modifier = Modifier.height(14.dp))
        Text("原作者更新通道（保留供查看）", fontWeight = FontWeight.Bold)
        Text(
            "可查询原作者的更新。原作者 APK 与维护版签名不同，不能直接覆盖安装；" +
                    "维护版更新始终优先，建议等待维护版跟进。",
            fontSize = 12.sp,
        )
        var officialUpdateStatus by remember { mutableStateOf("尚未查询官方更新") }
        OutlinedButton(onClick = {
            officialUpdateStatus = "正在检查原作者更新..."
            coroutineScope.launch {
                officialUpdateStatus = try {
                    val latest = withContext(Dispatchers.IO) {
                        stackbricksService.getManifest(dismissCache = true).latestStable
                    }
                    if (latest.versionCode.toLong() > BuildConfig.VERSION_CODE.toLong())
                        "原作者有新版本：" + latest.versionName + "（仅查看，不会覆盖安装）"
                    else
                        "原作者最新：" + latest.versionName + "；维护版已包含或高于此版本号"
                } catch (e: Exception) {
                    "官方更新检查失败：" + (e.message ?: "网络不可用")
                }
            }
        }) {
            Text("检查原作者更新")
        }
        Text(officialUpdateStatus, fontSize = 12.sp)
        OutlinedButton(onClick = {
            context.startActivity(
                Intent(Intent.ACTION_VIEW,
                    "https://github.com/aquamarine5/ChaoxingSignFaker/releases".toUri())
            )
        }) {
            Text("查看原作者发布页")
        }
'''
s=s[:start]+new_block+s[end:]
settings.write_text(s,encoding="utf-8")

provider=pkg/"utilities/OssCheckedPackageProvider.kt"
provider.write_text('''/*
 * Independent community update verification for the AGPL-3.0 application.
 */
package org.aquamarine5.brainspark.chaoxingsignfaker.utilities

import android.content.Context
import androidx.compose.runtime.MutableState
import androidx.core.content.pm.PackageInfoCompat
import org.aquamarine5.brainspark.chaoxingsignfaker.BuildConfig
import org.aquamarine5.brainspark.stackbricks.StackbricksDownloadPath
import org.aquamarine5.brainspark.stackbricks.StackbricksPackageFile
import org.aquamarine5.brainspark.stackbricks.StackbricksPackageProvider
import org.aquamarine5.brainspark.stackbricks.StackbricksVersionData
import org.aquamarine5.brainspark.stackbricks.providers.cloudflare.CloudflarePackageProvider
import java.security.MessageDigest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class OssCheckedPackageProvider(
    private val delegate: CloudflarePackageProvider
) : StackbricksPackageProvider {
    override val authority: String = delegate.authority

    @Suppress("DEPRECATION")
    override suspend fun downloadPackage(
        context: Context,
        versionData: StackbricksVersionData,
        downloadPath: StackbricksDownloadPath,
        downloadProgress: MutableState<Float?>?
    ): StackbricksPackageFile {
        val expected = downloadPath.additionalInformation.getString("sha256")?.lowercase()
            ?: throw IllegalArgumentException("OSS manifest is missing sha256")
        require(Regex("[0-9a-f]{64}").matches(expected)) {
            "Invalid OSS SHA-256 value"
        }
        val packageFile = delegate.downloadPackage(
            context, versionData, downloadPath, downloadProgress
        )
        try {
            withContext(Dispatchers.IO) {
                val md = MessageDigest.getInstance("SHA-256")
                packageFile.file.inputStream().buffered().use { input ->
                    val buffer = ByteArray(128 * 1024)
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        md.update(buffer, 0, read)
                    }
                }
                val actual = md.digest().joinToString("") { b ->
                    "%02x".format(b.toInt() and 0xff)
                }
                require(actual == expected) {
                    "OSS update package checksum mismatch"
                }
                val info = context.packageManager.getPackageArchiveInfo(
                    packageFile.file.absolutePath, 0
                ) ?: error("Downloaded file is not a valid APK")
                require(info.packageName == BuildConfig.APPLICATION_ID) {
                    "Wrong APK package name: " + info.packageName
                }
                require(PackageInfoCompat.getLongVersionCode(info) == versionData.versionCode.toLong()) {
                    "APK version does not match update manifest"
                }
            }
            return packageFile
        } catch (e: Exception) {
            packageFile.clean()
            throw e
        }
    }
}
''',encoding="utf-8")

gradle=root/"app/build.gradle"
g=gradle.read_text(encoding="utf-8")
oldcode='versionCode = 1_2000_1120'
oldname='versionName = "1.20.0-stable-261120"'
assert oldcode in g and oldname in g,"upstream version updated; review new version"
g=g.replace(oldcode,'versionCode = 1_2000_1121',1).replace(oldname,'versionName = "1.20.0-coren1"',1)
gradle.write_text(g,encoding="utf-8")

print("Dual-channel updater installed: community OSS prioritized, official read-only.")
print("Version: 1.20.0-coren1 / versionCode 120001121")
