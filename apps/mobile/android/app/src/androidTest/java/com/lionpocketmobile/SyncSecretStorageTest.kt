package com.lionpocketmobile

import android.util.Base64
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.KeyStore
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class SyncSecretStorageTest {
  // Disposable subtree in the target UID's private storage; never a financial DB or normal wrapper directory.
  private val targetContext = InstrumentationRegistry.getInstrumentation().targetContext
  private val testRoot = File(targetContext.noBackupFilesDir, "secret-store-instrumentation/" + UUID.randomUUID()).apply { check(mkdirs()) }
  private val context = object : android.content.ContextWrapper(targetContext) {
    override fun getNoBackupFilesDir(): File = testRoot
  }
  private val installation = UUID.randomUUID().toString()
  private val aad = JSONObject().apply {
    put("context", "LionPocket/epoch-preparation-wrap/v1"); put("formatVersion", 1); put("purpose", "epochPreparation")
    put("installationId", installation)
    for (field in listOf("anchorDeviceId", "serverId", "vaultId", "fromEpoch", "toEpoch", "restoreId")) put(field, UUID.randomUUID().toString())
  }.toString()
  private val bytes = ("PRIVATE_PREPARATION_CANARY_" + "s".repeat(4096)).toByteArray()
  private val encoded = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
  private fun wrappers() = File(File(context.noBackupFilesDir, "sync-preparations"), installation)
  private fun refuses(action: () -> Unit) {
    var failed = false
    try { action() } catch (_: Exception) { failed = true }
    assertTrue("Invalid or changed secret must fail", failed)
  }
  @After fun cleanup() {
    for (domain in listOf("sync-preparations", "sync-secrets")) File(File(context.noBackupFilesDir, domain), installation).deleteRecursively()
    val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    for (domain in listOf("epoch-preparation", "sync")) keys.deleteEntry("LionPocket/$domain/v1/$installation")
    testRoot.deleteRecursively()
    bytes.fill(0)
  }
  @Test fun durableImmutableRoundtripAndDomainIsolation() {
    val first = SyncSecretStorage(context)
    first.store(aad, encoded)
    assertTrue(SyncSecretStorage(context).load(aad) == encoded)
    first.store(aad, encoded)
    refuses { first.store(aad, Base64.encodeToString(ByteArray(64), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)) }
    val raw = wrappers().listFiles()!!.single().readBytes()
    assertFalse(raw.toString(Charsets.UTF_8).contains("PRIVATE_PREPARATION_CANARY"))
    assertEquals(2.toByte(), raw[0])
    val other = JSONObject(aad).put("restoreId", UUID.randomUUID().toString()).toString()
    assertNull(first.load(other))
    assertTrue(first.load(aad) == encoded)
    val maximum = Base64.encodeToString(ByteArray(131072) { 7 }, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    first.store(other, maximum)
    assertTrue(SyncSecretStorage(context).load(other) == maximum)
    refuses { first.store(JSONObject(aad).put("deviceId", UUID.randomUUID().toString()).toString(), encoded) }
  }
  @Test fun incompleteFirstWriteDoesNotBecomeADurableReservation() {
    SyncSecretStorage(context).load(aad) // Resolve the directory without reserving a public identity.
    val name = java.security.MessageDigest.getInstance("SHA-256").digest(aad.toByteArray()).joinToString("") { "%02x".format(it) }
    File(wrappers(), "$name.bin.new").writeBytes(byteArrayOf(2, 0, 0))
    val restarted = SyncSecretStorage(context)
    assertNull(restarted.load(aad))
    restarted.store(aad, encoded)
    assertTrue(SyncSecretStorage(context).load(aad) == encoded)
  }
  @Test fun tamperAndLostKeystoreKeyNeverRegenerateMaterial() {
    val store = SyncSecretStorage(context)
    store.store(aad, encoded)
    val file = wrappers().listFiles()!!.single()
    val original = file.readBytes()
    val corrupt = original.copyOf().apply { this[lastIndex] = (this[lastIndex].toInt() xor 1).toByte() }
    file.writeBytes(corrupt)
    refuses { SyncSecretStorage(context).load(aad) }
    refuses { store.store(aad, encoded) }
    file.writeBytes(original)
    KeyStore.getInstance("AndroidKeyStore").apply { load(null); deleteEntry("LionPocket/epoch-preparation/v1/$installation") }
    refuses { store.load(aad) }
    refuses { store.store(aad, encoded) }
    assertTrue(file.readBytes().contentEquals(original))
  }
  @Test fun operationalWrappersKeepV1And32ByteLimit() {
    val operational = JSONObject().apply {
      put("context", "LionPocket/local-wrap/v1"); put("installationId", installation); put("purpose", "dataKey"); put("keyVersion", 1)
      for (field in listOf("deviceId", "serverId", "serverEpoch", "vaultId")) put(field, UUID.randomUUID().toString())
    }.toString()
    val secret = Base64.encodeToString(ByteArray(32) { 7 }, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    val store = SyncSecretStorage(context)
    store.store(operational, secret)
    store.store(aad, encoded)
    assertTrue(SyncSecretStorage(context).load(operational) == secret)
    val file = File(File(context.noBackupFilesDir, "sync-secrets"), installation).listFiles()!!.single()
    assertEquals(61L, file.length()); assertEquals(1.toByte(), file.readBytes()[0])
    refuses { store.store(operational, encoded) }
    assertTrue(store.load(operational) == secret)
  }
}
