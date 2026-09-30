package com.lionpocketmobile

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Base64
import com.facebook.react.bridge.*
import com.facebook.react.ReactPackage
import com.facebook.react.uimanager.ViewManager
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import java.util.concurrent.Executors
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

/** AES wrappers in noBackupFilesDir; neither keys nor wrappers enter financial backups. */
class SyncSecretsModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val executor = Executors.newSingleThreadExecutor()
  override fun getName() = "LionPocketSecrets"
  private fun alias(aad: String): String {
    val value = JSONObject(aad)
    require(value.getString("context") == "LionPocket/local-wrap/v1")
    val installation = value.getString("installationId")
    require(installation.matches(Regex("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")))
    return "LionPocket/sync/v1/$installation"
  }
  private fun file(aad: String): AtomicFile {
    alias(aad)
    val name = MessageDigest.getInstance("SHA-256").digest(aad.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    val directory = File(File(context.noBackupFilesDir, "sync-secrets"), JSONObject(aad).getString("installationId")).apply { check(mkdirs() || isDirectory) }
    return AtomicFile(File(directory, "$name.bin"))
  }
  private fun key(aad: String, create: Boolean): SecretKey {
    val name = alias(aad)
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    val existing = store.getKey(name, null)
    if (existing != null) return existing as SecretKey
    check(create) { "Keystore key missing; explicit reprovisioning required." }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(KeyGenParameterSpec.Builder(name, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
      .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setRandomizedEncryptionRequired(true).build())
    return generator.generateKey()
  }
  private fun run(promise: Promise, action: () -> Any?) {
    executor.execute { try { promise.resolve(action()) } catch (error: Exception) { promise.reject("SYNC_SECRET", "System secret storage failed.", error) } }
  }
  @ReactMethod fun store(aad: String, encoded: String, promise: Promise) = run(promise) {
    val secret = Base64.decode(encoded, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    require(secret.size == 32 && Base64.encodeToString(secret, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING) == encoded)
    val target = file(aad)
    // Never silently replace a lost key when an encrypted wrapper already exists.
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key(aad, target.baseFile.parentFile!!.listFiles()?.none { it.name.endsWith(".bin") } == true))
    cipher.updateAAD(aad.toByteArray(Charsets.UTF_8))
    val encrypted = try { cipher.doFinal(secret) } finally { secret.fill(0) }
    check(cipher.iv.size == 12 && encrypted.size == 48)
    val stream = target.startWrite()
    try { stream.write(byteArrayOf(1) + cipher.iv + encrypted); target.finishWrite(stream) }
    catch (error: Exception) { target.failWrite(stream); throw error }
    null
  }
  @ReactMethod fun load(aad: String, promise: Promise) = run(promise) {
    val target = file(aad)
    if (!target.baseFile.exists()) null else {
      val bytes = target.openRead().use { it.readBytes() }
      require(bytes.size == 61 && bytes[0] == 1.toByte())
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, key(aad, false), GCMParameterSpec(128, bytes.copyOfRange(1,13)))
      cipher.updateAAD(aad.toByteArray(Charsets.UTF_8))
      val secret = cipher.doFinal(bytes.copyOfRange(13,61))
      try { Base64.encodeToString(secret, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING) } finally { secret.fill(0) }
    }
  }
  @ReactMethod fun remove(aad: String, promise: Promise) = run(promise) { file(aad).delete(); null }
}
class SyncSecretsPackage : ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> = listOf(SyncSecretsModule(context))
  override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
