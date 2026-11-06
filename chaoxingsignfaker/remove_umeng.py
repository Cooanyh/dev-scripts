#!/usr/bin/env python3
"""ChaoxingSignFaker: remove the Umeng SDK while retaining local sign counters.

Target: upstream snapshot 071c2e07239b16b690d5eef01f8c514ab7a31d9c.
This script fails closed when expected source markers change.
"""
from pathlib import Path
import re
import sys

root = Path(sys.argv[1]).resolve()
base = root / "app/src/main/java/org/aquamarine5/brainspark/chaoxingsignfaker"
def edit(path, fn):
    p=root/path
    assert p.is_file(), f"missing: {p}"
    old=p.read_text()
    new=fn(old)
    assert new != old, f"unchanged: {path}"
    p.write_text(new)
    print("patched", path)
def remove_lines(text, terms):
    return "".join(line for line in text.splitlines(True) if not any(t in line for t in terms))

# Replace the remote telemetry implementation with an offline facade.
# The original app calls UMengHelper for local counters too, so preserve that API.
helper=base/"utilities/UMengHelper.kt"
assert helper.exists()
helper.write_text('''/*
 * Copyright (c) 2025-2026, @aquamarine5 and Brainspark.
 * Privacy adaptation: Umeng SDK removed; local sign counters preserved.
 * Licensed under upstream AGPL-3.0 terms.
 */
package org.aquamarine5.brainspark.chaoxingsignfaker.utilities

import android.content.Context
import android.content.pm.PackageInfo
import org.aquamarine5.brainspark.chaoxingsignfaker.datastore.ChaoxingOtherUserSession
import org.aquamarine5.brainspark.chaoxingsignfaker.entity.ChaoxingLocationSignEntity
import org.aquamarine5.brainspark.stackbricks.StackbricksVersionData
import java.security.MessageDigest

// Kept as a compatibility name. This contains NO Umeng SDK or network calls.
object UMengHelper {
    fun md5(str: String): String = MessageDigest.getInstance("MD5")
        .digest(str.toByteArray()).toHexString()

    fun preInit(context: Context) = Unit
    fun init(context: Context) = Unit
    fun profileSignIn(puid: Int, name: String, phoneNumber: String) = Unit
    fun profileSignOff() = Unit
    fun onLoginEvent(context: Context, phoneNumber: String) = Unit
    fun onIllegalChannelEvent(context: Context, applicationInfo: PackageInfo) = Unit

    suspend fun onSignGestureEvent(context: Context, name: String, isOtherUser: Boolean = false) {
        ChaoxingAnalyser.onGestureSignEvent(context)
        if (isOtherUser) ChaoxingAnalyser.onOtherUserSignEvent(context)
    }
    suspend fun onSignCodeEvent(context: Context, name: String, isOtherUser: Boolean = false) {
        ChaoxingAnalyser.onPasswordSignEvent(context)
        if (isOtherUser) ChaoxingAnalyser.onOtherUserSignEvent(context)
    }
    suspend fun onSignLocationEvent(
        context: Context, postLocationEntity: ChaoxingLocationSignEntity,
        name: String, isOtherUser: Boolean = false
    ) {
        ChaoxingAnalyser.onLocationSignEvent(context)
        if (isOtherUser) ChaoxingAnalyser.onOtherUserSignEvent(context)
    }
    suspend fun onSignQRCodeEvent(context: Context, name: String, isOtherUser: Boolean = false) {
        ChaoxingAnalyser.onQRCodeSignEvent(context)
        if (isOtherUser) ChaoxingAnalyser.onOtherUserSignEvent(context)
    }
    suspend fun onSignClickEvent(context: Context, name: String, isOtherUser: Boolean = false) {
        ChaoxingAnalyser.onClickSignEvent(context)
        if (isOtherUser) ChaoxingAnalyser.onOtherUserSignEvent(context)
    }
    suspend fun onSignPhotoEvent(context: Context, name: String, isOtherUser: Boolean = false) {
        ChaoxingAnalyser.onPhotoSignEvent(context)
        if (isOtherUser) ChaoxingAnalyser.onOtherUserSignEvent(context)
    }
    fun onAccountOtherUserAddEvent(context: Context, userEntity: ChaoxingOtherUserSession) = Unit
    fun onGotoSponsorWechatEvent(context: Context, name: String) = Unit
    fun onStackbricksCheckUpdateEvent(context: Context, name: String) = Unit
    fun onStackbricksInstallNewestEvent(
        context: Context, name: String, versionData: StackbricksVersionData
    ) = Unit
    fun onStackbricksInstallTestChannelEvent(
        context: Context, name: String, versionData: StackbricksVersionData
    ) = Unit
    fun onStackbricksCheckOnLaunchChangedEvent(context: Context, name: String, status: Boolean) = Unit
    fun onStackbricksTestChannelChangedEvent(context: Context, name: String, status: Boolean) = Unit
}
''')
print("replaced", helper)

# Direct calls in Android lifecycle and the import activity.
for name in ("MainActivity.kt","ImportOtherUserActivity.kt"):
    p=base/name
    s=p.read_text()
    assert "MobclickAgent" in s, name
    s=s.replace("import com.umeng.analytics.MobclickAgent\n","")
    s,n=re.subn(r"(?m)^[ \t]*MobclickAgent\.\w+\([^\n]*\)\s*\n","",s)
    assert n>0, name
    p.write_text(s)
    print("removed MobclickAgent", name, n)

# Umeng.getOaid is a direct SDK dependency: replace it with local Android ID.
p=base/"api/ChaoxingDeviceInfoHelper.kt"
s=p.read_text()
a=s.index("    private suspend fun getLocalMachineUniqueId(context: Context): String {")
b=s.index('    @SuppressLint("HardwareIds")',a)
s=s[:a]+'''    // No Umeng OAID. Existing cached device codes remain untouched.
    // New device codes derive from Android ID, and may differ from upstream.
    @SuppressLint("HardwareIds")
    private suspend fun getLocalMachineUniqueId(context: Context): String {
        val id = Settings.Secure.getString(
            context.contentResolver, Settings.Secure.ANDROID_ID
        ).orEmpty()
        return id.takeIf {
            it.isNotBlank() && !INVALID_UNIQUE_ID_REGEX.matches(it.replace("-", ""))
        }.orEmpty()
    }

'''+s[b:]
s=remove_lines(s,("import com.umeng.commonsdk.UMConfigure","import kotlinx.coroutines.suspendCancellableCoroutine","import kotlinx.coroutines.withTimeout","import kotlin.coroutines.resume","import kotlin.time.Duration.Companion.seconds"))
p.write_text(s)
print("replaced Umeng OAID dependency")

# Explicit Umeng dependencies / version catalog.
p=root/"app/build.gradle"
s=p.read_text()
for line in ("    implementation libs.common\n","    implementation libs.asms\n"):
    assert s.count(line)==1, line
    s=s.replace(line,"")
# Keep a local channel label for existing UI screens, but no Umeng SDK receives it.
channel_line = '            buildConfigField("String", "umengChannel", "' + chr(92) + '"PrivacyEdition' + chr(92) + '"")' + chr(10)
s = ''.join(channel_line if 'buildConfigField("String", "umengChannel"' in line else line for line in s.splitlines(True))
# Match the whole signingConfigs block without relying on Windows path escaping.
pattern = r'(?ms)^    signingConfigs \{\n.*?^    \}\n'
s, count = re.subn(pattern, "", s, count=1)
assert count == 1, "upstream signing config changed"
assert s.count("signingConfig signingConfigs.chaoxingsignfaker") == 2
s = s.replace("signingConfig signingConfigs.chaoxingsignfaker", "", 1)
s = s.replace("signingConfig signingConfigs.chaoxingsignfaker", "signingConfig signingConfigs.debug", 1)
p.write_text(s)
print("removed Umeng dependencies and upstream signing key")

p=root/"gradle/libs.versions.toml"
s=p.read_text()
for line in ("asms = ","common = "):
    assert sum(x.startswith(line) for x in s.splitlines())==2, f"expected version and library for {line}"
s="".join(x for x in s.splitlines(True) if not x.startswith(("asms = ","common = ")))
p.write_text(s)

# Precisely drop only the Umeng URL handler; preserve the LAUNCHER intent filter.
p=root/"app/src/main/AndroidManifest.xml"
s=p.read_text()
pos=s.index('android:scheme="um.')
start=s.rfind("<intent-filter>",0,pos)
end=s.index("</intent-filter>",pos)+len("</intent-filter>")
assert start!=-1 and s.count('android:scheme="um.')==1
s=s[:start]+s[end:]
assert 'android.intent.action.MAIN' in s and 'android.intent.category.LAUNCHER' in s
assert 'android:scheme="um.' not in s
p.write_text(s)
print("removed only Umeng deep link; launcher preserved")

p=root/"app/proguard-rules.pro"
s=p.read_text()
s=remove_lines(s,("-keep class com.umeng.","-dontwarn com.umeng.","-dontnote com.umeng.",
                  "-keep class org.repackage.","-keep class com.uyumao.","-keep class com.uc.","-keep class com.efs."))
p.write_text(s)

p=base/"screen/WelcomeScreen.kt"
s=p.read_text()
disclosure='''使用SDK名称：友盟SDK
服务类型：使用数据分析
收集个人信息类型：设备信息（IMEI/MAC/Android ID/IDFA/OpenUDID/GUID/IP地址/SIM 卡 IMSI 信息等）
隐私权政策链接：https://www.umeng.com/page/policy

'''
assert disclosure in s, "disclosure changed"
p.write_text(s.replace(disclosure,""))
print("removed Umeng disclosure")

# The original presentation-only Umeng logo must not be shipped either.
logo = root / "app/src/main/res/drawable/ic_umeng.xml"
if logo.exists():
    logo.unlink()
    print("removed unused Umeng logo asset")

# No remaining SDK entry points. The UMengHelper name is a local offline facade.
for p in (root/"app/src/main/java").rglob("*.kt"):
    x=p.read_text()
    for term in ("com.umeng.","MobclickAgent","UMConfigure.getOaid"):
        assert term not in x, f"{term} in {p}"
print("SUCCESS: source-level Umeng API and direct dependency removed")
