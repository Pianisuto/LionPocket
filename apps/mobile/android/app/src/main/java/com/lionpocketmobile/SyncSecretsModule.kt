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

/** Actual AndroidKeyStore/AtomicFile adapter. Preparation has a separate AAD domain, key alias and directory. */
internal class SyncSecretStorage(private val context: android.content.Context) {
  companion object {
    private val lock = Any()
    private const val MAX_PREPARATION_BYTES = 131072
    private val uuid = Regex("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
  }
  private fun preparation(aad: String): Boolean {
    val value = JSONObject(aad)
    val domain = value.getString("context")
    require(domain == "LionPocket/local-wrap/v1" || domain == "LionPocket/epoch-preparation-wrap/v1")
    require(value.getString("installationId").matches(uuid))
    if (domain == "LionPocket/local-wrap/v1") return false
    require(value.keys().asSequence().toSet() == setOf("context", "formatVersion", "purpose", "installationId", "anchorDeviceId", "serverId", "vaultId", "fromEpoch", "toEpoch", "restoreId"))
    require(value.get("formatVersion") == 1 && value.getString("purpose") == "epochPreparation")
    for (field in listOf("anchorDeviceId", "serverId", "vaultId", "fromEpoch", "toEpoch", "restoreId")) require(value.getString(field).matches(uuid))
    require(value.getString("fromEpoch") != value.getString("toEpoch"))
    return true
  }
  private fun alias(aad: String): String =
    "LionPocket/" + (if (preparation(aad)) "epoch-preparation/v1/" else "sync/v1/") + JSONObject(aad).getString("installationId")
  private fun file(aad: String): AtomicFile {
    val domain = if (preparation(aad)) "sync-preparations" else "sync-secrets"
    val name = MessageDigest.getInstance("SHA-256").digest(aad.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    val directory = File(File(context.noBackupFilesDir, domain), JSONObject(aad).getString("installationId")).apply { check(mkdirs() || isDirectory) }
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
  private fun validLength(preparation: Boolean, size: Int) = if (preparation) size in 1..MAX_PREPARATION_BYTES else size == 32
  fun store(aad: String, encoded: String): Unit = synchronized(lock) {
    val preparing = preparation(aad)
    require(encoded.length <= if (preparing) (MAX_PREPARATION_BYTES * 4 + 2) / 3 else 43)
    val secret = Base64.decode(encoded, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    try {
      require(validLength(preparing, secret.size) && Base64.encodeToString(secret, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING) == encoded)
      val target = file(aad)
      if (preparing && target.baseFile.exists()) {
        val existing = load(aad)
        check(existing == encoded) { "Preparation secret is immutable." }
        return@synchronized
      }
      // Never silently replace a lost key when an encrypted wrapper already exists in this domain.
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.ENCRYPT_MODE, key(aad, target.baseFile.parentFile!!.listFiles()?.none { it.name.endsWith(".bin") } == true))
      cipher.updateAAD(aad.toByteArray(Charsets.UTF_8))
      val encrypted = cipher.doFinal(secret)
      check(cipher.iv.size == 12 && encrypted.size == secret.size + 16)
      val stream = target.startWrite()
      try { stream.write(byteArrayOf(if (preparing) 2 else 1) + cipher.iv + encrypted); target.finishWrite(stream) }
      catch (error: Exception) { target.failWrite(stream); throw error }
    } finally { secret.fill(0) }
  }
  fun load(aad: String): String? = synchronized(lock) {
    val preparing = preparation(aad)
    val target = file(aad)
    if (!target.baseFile.exists()) return@synchronized null
    val bytes = target.openRead().use { stream ->
      require(stream.channel.size() <= if (preparing) (MAX_PREPARATION_BYTES + 29).toLong() else 61L)
      stream.readBytes()
    }
    require(validLength(preparing, bytes.size - 29) && bytes[0] == (if (preparing) 2 else 1).toByte())
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, key(aad, false), GCMParameterSpec(128, bytes.copyOfRange(1,13)))
    cipher.updateAAD(aad.toByteArray(Charsets.UTF_8))
    val secret = cipher.doFinal(bytes.copyOfRange(13,bytes.size))
    try {
      require(validLength(preparing, secret.size))
      Base64.encodeToString(secret, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    } finally { secret.fill(0) }
  }
  fun remove(aad: String): Unit = synchronized(lock) { file(aad).delete() }
}
/** AES wrappers in noBackupFilesDir; neither keys nor wrappers enter financial backups. */
class SyncSecretsModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val storage = SyncSecretStorage(context)
  private val executor = Executors.newSingleThreadExecutor()
  override fun getName() = "LionPocketSecrets"
  private fun run(promise: Promise, action: () -> Any?) {
    executor.execute { try { promise.resolve(action()) } catch (_: Exception) { promise.reject("SYNC_SECRET", "System secret storage failed.") } }
  }
  @ReactMethod fun store(aad: String, encoded: String, promise: Promise) = run(promise) { storage.store(aad, encoded); null }
  @ReactMethod fun load(aad: String, promise: Promise) = run(promise) { storage.load(aad) }
  @ReactMethod fun remove(aad: String, promise: Promise) = run(promise) { storage.remove(aad); null }
}
class SyncSecretsPackage : ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> = listOf(SyncSecretsModule(context))
  override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
