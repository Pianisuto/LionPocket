package com.lionpocketmobile

import android.util.Base64
import com.facebook.react.bridge.*
import com.facebook.react.ReactPackage
import com.facebook.react.uimanager.ViewManager
import java.math.BigInteger
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.RSAPublicKeySpec
import java.util.concurrent.Executors
import org.json.JSONObject

/** Public RS256 verification only. Sessions, tokens and private keys are never persisted. */
class SyncIdentityModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val executor = Executors.newSingleThreadExecutor()
  override fun getConstants(): MutableMap<String, Any> = mutableMapOf("privateBeta" to BuildConfig.PRIVATE_BETA)

  override fun getName() = "LionPocketIdentity"
  private fun bytes(text: String) = Base64.decode(text, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
  @ReactMethod fun verify(token: String, jwks: String, issuer: String, audience: String, clientId: String, nonce: String?, access: Boolean, promise: Promise) {
    executor.execute {
      try {
        require(token.length <= 16384 && jwks.length <= 65536)
        val parts = token.split('.')
        require(parts.size == 3 && parts.all { it.matches(Regex("[A-Za-z0-9_-]+")) })
        val header = JSONObject(String(bytes(parts[0]), Charsets.UTF_8))
        require(header.getString("alg") == "RS256" && !header.has("crit"))
        val keys = JSONObject(jwks).getJSONArray("keys")
        require(keys.length() <= 32)
        val matches = (0 until keys.length()).map { keys.getJSONObject(it) }.filter { it.optString("kid") == header.getString("kid") && it.optString("kty") == "RSA" }
        require(matches.size == 1)
        val jwk = matches[0]
        require(!jwk.has("alg") || jwk.getString("alg") == "RS256")
        require(!jwk.has("use") || jwk.getString("use") == "sig")
        val publicKey = KeyFactory.getInstance("RSA").generatePublic(RSAPublicKeySpec(BigInteger(1, bytes(jwk.getString("n"))), BigInteger(1, bytes(jwk.getString("e")))))
        val verifier = Signature.getInstance("SHA256withRSA")
        verifier.initVerify(publicKey); verifier.update((parts[0] + "." + parts[1]).toByteArray(Charsets.US_ASCII))
        require(verifier.verify(bytes(parts[2])))
        val claims = JSONObject(String(bytes(parts[1]), Charsets.UTF_8))
        val now = System.currentTimeMillis() / 1000
        require(claims.getString("iss") == issuer && claims.getLong("exp") > now && claims.getLong("iat") <= now + 60)
        require(!claims.has("nbf") || claims.getLong("nbf") <= now)
        val aud = claims.get("aud")
        require((aud is String && aud == audience) || (aud is org.json.JSONArray && (0 until aud.length()).any { aud.getString(it) == audience }))
        if (access) require(claims.getString("azp") == clientId && claims.getString("typ") == "Bearer")
        else {
          require(!claims.has("azp") || claims.getString("azp") == clientId)
          require(nonce != null && claims.getString("nonce") == nonce)
        }
        val subject = claims.getString("sub"); require(subject.isNotEmpty())
        promise.resolve(subject)
      } catch (error: Exception) { promise.reject("SYNC_IDENTITY", "OIDC identity validation failed.", error) }
    }
  }
}
class SyncIdentityPackage : ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> = listOf(SyncIdentityModule(context))
  override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
