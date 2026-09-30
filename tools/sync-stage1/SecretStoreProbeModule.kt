package com.lionpocketmobile

import com.facebook.react.bridge.*
import com.facebook.react.ReactPackage
import com.facebook.react.uimanager.ViewManager
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import org.json.JSONObject

/** Disposable harness only. Faults the actual encrypted-wrapper file, never production APKs. */
class SecretStoreProbeModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  override fun getName() = "SecretStoreProbe"
  private fun file(aad: String): File {
    val name = MessageDigest.getInstance("SHA-256").digest(aad.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    return File(File(File(reactApplicationContext.noBackupFilesDir,"sync-secrets"),JSONObject(aad).getString("installationId")),"$name.bin")
  }
  @ReactMethod fun probe(aad: String, other: String, action: String, promise: Promise) {
    try {
      val f = file(aad)
      when(action) {
        "nonce" -> promise.resolve(f.readBytes().copyOfRange(1,13).joinToString("") { "%02x".format(it) })
        "tamper" -> { val bytes=f.readBytes(); bytes[60]=(bytes[60].toInt() xor 1).toByte(); f.writeBytes(bytes); promise.resolve(null) }
        "copy" -> { f.copyTo(file(other),overwrite=true); promise.resolve(null) }
        "deleteKey" -> { val store=KeyStore.getInstance("AndroidKeyStore").apply{load(null)}
          store.deleteEntry("LionPocket/sync/v1/"+JSONObject(aad).getString("installationId")); promise.resolve(null) }
        else -> throw IllegalArgumentException("Invalid probe")
      }
    } catch(error:Exception){promise.reject("TEST_PROBE","Test probe failed.",error)}
  }
}
class SecretStoreProbePackage : ReactPackage {
  override fun createNativeModules(context:ReactApplicationContext):List<NativeModule> = listOf(SecretStoreProbeModule(context))
  override fun createViewManagers(context:ReactApplicationContext):List<ViewManager<*,*>> = emptyList()
}
