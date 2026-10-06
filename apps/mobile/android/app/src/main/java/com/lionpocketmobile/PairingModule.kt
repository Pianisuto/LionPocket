package com.lionpocketmobile

import android.os.Build
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.util.Base64
import java.io.ByteArrayOutputStream
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.*
import com.facebook.react.uimanager.ViewManager
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning

/** Scan locally using Play services; no camera permission or image upload. No URL is logged. */
class PairingModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private var scanning = false
  override fun getName() = "LionPocketPairing"
  override fun getConstants(): Map<String, Any> = mapOf("deviceName" to Build.MODEL.take(80))
  @ReactMethod fun copyLink(link: String, promise: Promise) {
    if (link.length > 4096 || !link.startsWith("lionpocket://pair/LPV2.")) {
      promise.reject("PAIRING_COPY", "Convite inválido"); return
    }
    val clipboard = reactApplicationContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    val clip = ClipData.newPlainText("Convite LionPocket", link)
    if (Build.VERSION.SDK_INT >= 33) clip.description.extras = android.os.PersistableBundle().apply {
      putBoolean(android.content.ClipDescription.EXTRA_IS_SENSITIVE, true)
    }
    clipboard.setPrimaryClip(clip)
    promise.resolve(null)
  }
  /** Render the local matrix in memory. Thousands of React Native views would make the QR screen sluggish. */
  @ReactMethod fun renderQr(rows: ReadableArray, promise: Promise) {
    try {
      val size = rows.size()
      require(size in 29..185)
      val bitmap = Bitmap.createBitmap(size * 6, size * 6, Bitmap.Config.ARGB_8888)
      try {
        val canvas = Canvas(bitmap)
        canvas.drawColor(Color.WHITE)
        val paint = Paint().apply { color = Color.BLACK; isAntiAlias = false }
        for (y in 0 until size) {
          val row = rows.getString(y) ?: throw IllegalArgumentException()
          require(row.length == size && row.all { it == '0' || it == '1' })
          for (x in 0 until size) if (row[x] == '1') canvas.drawRect((x * 6).toFloat(), (y * 6).toFloat(), ((x + 1) * 6).toFloat(), ((y + 1) * 6).toFloat(), paint)
        }
        val output = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)
        promise.resolve("data:image/png;base64," + Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP))
      } finally { bitmap.recycle() }
    } catch (_: Exception) { promise.reject("PAIRING_QR", "Não foi possível mostrar o QR. Compartilhe o convite.") }
  }
  @ReactMethod fun scan(promise: Promise) {
    val activity = reactApplicationContext.currentActivity
    if (activity == null) { promise.reject("PAIRING_SCAN", "Leitor indisponível. Cole o convite."); return }
    activity.runOnUiThread {
      if (scanning) { promise.reject("PAIRING_SCAN", "O leitor já está aberto."); return@runOnUiThread }
      scanning = true
      val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).enableAutoZoom().build()
      GmsBarcodeScanning.getClient(activity, options).startScan()
        .addOnSuccessListener { barcode ->
          scanning = false
          val value = barcode.rawValue
          if (value != null && value.length <= 4096 && (value.startsWith("lionpocket://pair/LPV2.") || value.startsWith("LPV2."))) promise.resolve(value)
          else promise.reject("PAIRING_SCAN", "Convite inválido")
        }
        .addOnCanceledListener { scanning = false; promise.resolve("") }
        .addOnFailureListener { scanning = false; promise.reject("PAIRING_SCAN", "Leitor indisponível. Cole o convite.") }
    }
  }
}
class PairingPackage : ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> = listOf(PairingModule(context))
  override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
