package com.lionpocketmobile

import android.util.Log
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.NativeModule
import com.facebook.react.ReactPackage
import com.facebook.react.uimanager.ViewManager
import java.io.File
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.GCMParameterSpec
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.KeyInfo
import javax.crypto.SecretKeyFactory
import org.json.JSONObject

// Test report contains public fixtures only; this package has separate Android storage.
class CryptoSpikeReportModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  override fun getName() = "CryptoSpikeReport"
  private fun checkKeystore(): JSONObject {
    val alias = "LionPocketCryptoSpike-" + UUID.randomUUID()
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    try {
      val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
      generator.init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setRandomizedEncryptionRequired(true).build())
      val key = generator.generateKey()
      val material = ByteArray(32) { it.toByte() } // PUBLIC test bytes only.
      val aad = "LionPocket/local-wrap/spike/v1".toByteArray(Charsets.UTF_8)
      fun wrap(): Pair<ByteArray, ByteArray> {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key); cipher.updateAAD(aad)
        return Pair(cipher.iv, cipher.doFinal(material))
      }
      fun open(nonce: ByteArray, ciphertext: ByteArray, associated: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, nonce)); cipher.updateAAD(associated)
        return cipher.doFinal(ciphertext)
      }
      val (nonce, encrypted) = wrap(); val (nextNonce, _) = wrap()
      check(nonce.size == 12); check(encrypted.size == 48)
      check(!nonce.contentEquals(nextNonce)); check(open(nonce, encrypted, aad).contentEquals(material))
      val corrupted = encrypted.copyOf().apply { this[0] = (this[0].toInt() xor 1).toByte() }
      for ((ciphertext, associated) in listOf(Pair(corrupted, aad), Pair(encrypted, byteArrayOf(1)))) {
        var refused = false
        try { open(nonce, ciphertext, associated) } catch (_: java.security.GeneralSecurityException) { refused = true }
        check(refused)
      }
      val info = SecretKeyFactory.getInstance(key.algorithm, "AndroidKeyStore").getKeySpec(key, KeyInfo::class.java) as KeyInfo
      return JSONObject().put("result", "PASS").put("checks", 6).put("algorithm", "AES-256-GCM")
        .put("securityLevel", info.securityLevel).put("hardwareClaim", false)
    } finally { store.deleteEntry(alias) }
  }
  @ReactMethod fun report(input: String) {
    val report = JSONObject(input)
    try { report.put("keystore", checkKeystore()) }
    catch (error: Exception) { report.put("result", "FAIL").put("keystoreError", error.toString()) }
    val value = report.toString()
    File(reactApplicationContext.filesDir, "crypto-result.json").writeText(value)
    Log.i("LionCryptoSpike", value)
  }
}
class CryptoSpikeReportPackage : ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> = listOf(CryptoSpikeReportModule(context))
  override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
