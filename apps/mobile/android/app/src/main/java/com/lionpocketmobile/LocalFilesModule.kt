package com.lionpocketmobile

import android.app.Activity
import android.content.Intent
import android.provider.OpenableColumns
import android.util.Base64
import com.facebook.react.bridge.*
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

/** Storage Access Framework: no storage permission, account or network required. */
class LocalFilesModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val executor = Executors.newSingleThreadExecutor()
  private var pending: Promise? = null
  private var exportFile: File? = null
  private val limit = 20L * 1024 * 1024

  init {
    context.addActivityEventListener(object : BaseActivityEventListener() {
      override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != 8421 && requestCode != 8422) return
        val promise = pending ?: return
        val source = exportFile
        pending = null; exportFile = null
        if (resultCode != Activity.RESULT_OK || data?.data == null) { promise.resolve(null); return }
        val uri = data.data!!
        executor.execute {
          var copied: File? = null
          try {
            if (requestCode == 8422) {
              context.contentResolver.openOutputStream(uri, "wt").use { output ->
                requireNotNull(output) { "Não foi possível abrir o destino." }
                requireNotNull(source).inputStream().use { it.copyTo(output) }
                output.flush()
              }
              promise.resolve(true)
            } else {
              var displayName = "arquivo"
              context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) displayName = cursor.getString(0) ?: displayName
              }
              val extension = displayName.substringAfterLast('.', "").lowercase()
              require(extension in listOf("json", "csv", "xlsx", "sqlite", "db")) { "Selecione JSON, CSV, XLSX ou SQLite." }
              val file = File(directory("transfers"), "${UUID.randomUUID()}.$extension")
              copied = file
              context.contentResolver.openInputStream(uri).use { input ->
                requireNotNull(input) { "Não foi possível ler o arquivo." }
                file.outputStream().use { output ->
                  val buffer = ByteArray(65536); var size = 0L
                  while (true) {
                    val count = input.read(buffer); if (count < 0) break
                    size += count; require(size <= limit) { "O arquivo ultrapassa o limite de 20 MB." }
                    output.write(buffer, 0, count)
                  }
                }
              }
              val result = descriptor(file, "transfers")
              result.putString("displayName", displayName)
              promise.resolve(result)
            }
          } catch (error: Exception) {
            copied?.delete()
            promise.reject("LOCAL_FILE", error.message, error)
          }
        }
      }
    })
  }
  override fun getName() = "LionPocketFiles"
  private fun directory(folder: String): File {
    require(folder == "transfers" || folder == "backups") { "Pasta inválida." }
    return File(context.filesDir, folder).apply { mkdirs() }
  }
  private fun file(folder: String, name: String): File {
    require(name.matches(Regex("[a-zA-Z0-9._-]+")) && !name.startsWith('.')) { "Nome inválido." }
    return File(directory(folder), name)
  }
  private fun descriptor(file: File, folder: String): WritableMap = Arguments.createMap().apply {
    putString("name", file.name); putString("location", folder); putString("path", file.absolutePath)
  }
  @ReactMethod fun prepareFile(folder: String, extension: String, promise: Promise) {
    try {
      require(extension in listOf("json", "csv", "sqlite"))
      val name = "LionPocket-${System.currentTimeMillis()}-${UUID.randomUUID()}.$extension"
      promise.resolve(descriptor(file(folder, name), folder))
    } catch (error: Exception) { promise.reject("LOCAL_FILE", error.message, error) }
  }
  @ReactMethod fun writeText(folder: String, name: String, content: String, promise: Promise) {
    executor.execute { try { file(folder, name).writeText(content, Charsets.UTF_8); promise.resolve(null) }
      catch (error: Exception) { promise.reject("LOCAL_FILE", error.message, error) } }
  }
  @ReactMethod fun readText(name: String, promise: Promise) {
    executor.execute { try { val f = file("transfers", name); require(f.length() <= limit); promise.resolve(f.readText(Charsets.UTF_8)) }
      catch (error: Exception) { promise.reject("LOCAL_FILE", error.message, error) } }
  }
  @ReactMethod fun readBase64(name: String, promise: Promise) {
    executor.execute { try { val f = file("transfers", name); require(f.length() <= limit); promise.resolve(Base64.encodeToString(f.readBytes(), Base64.NO_WRAP)) }
      catch (error: Exception) { promise.reject("LOCAL_FILE", error.message, error) } }
  }
  private fun launch(intent: Intent, code: Int, promise: Promise, source: File? = null) {
    context.runOnUiQueueThread {
      if (pending != null) { promise.reject("LOCAL_FILE", "Já existe um seletor de arquivos aberto."); return@runOnUiQueueThread }
      val activity = context.currentActivity
      if (activity == null) { promise.reject("LOCAL_FILE", "Abra o aplicativo para escolher o arquivo."); return@runOnUiQueueThread }
      pending = promise; exportFile = source
      try { activity.startActivityForResult(intent, code) }
      catch (error: Exception) { pending = null; exportFile = null; promise.reject("LOCAL_FILE", error.message, error) }
    }
  }
  @ReactMethod fun pickFile(promise: Promise) {
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply { addCategory(Intent.CATEGORY_OPENABLE); type = "*/*" }
    launch(intent, 8421, promise)
  }
  @ReactMethod fun saveFile(folder: String, name: String, mime: String, displayName: String, promise: Promise) {
    try {
      val source = file(folder, name); require(source.isFile) { "Arquivo local não encontrado." }
      val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE); type = mime; putExtra(Intent.EXTRA_TITLE, displayName)
      }
      launch(intent, 8422, promise, source)
    } catch (error: Exception) { promise.reject("LOCAL_FILE", error.message, error) }
  }
  @ReactMethod fun listBackups(promise: Promise) {
    executor.execute { try {
      val result = Arguments.createArray()
      directory("backups").listFiles()?.filter { it.isFile && it.extension == "sqlite" }?.sortedByDescending { it.lastModified() }?.forEach {
        val item = descriptor(it, "backups"); item.putDouble("createdAt", it.lastModified().toDouble()); item.putDouble("size", it.length().toDouble()); result.pushMap(item)
      }
      promise.resolve(result)
    } catch (error: Exception) { promise.reject("LOCAL_FILE", error.message, error) } }
  }
  @ReactMethod fun fingerprintBackup(name: String, seal: Boolean, promise: Promise) {
    executor.execute { try {
      val (source, digest) = DurableBackupFile.fingerprint(directory("backups"), name, seal)
      val result = descriptor(source, "backups"); result.putString("sha256", digest); promise.resolve(result)
    } catch (_: Exception) { promise.reject("EPOCH_BACKUP", "epoch_backup_invalid") } }
  }
  @ReactMethod fun copyBackup(name: String, promise: Promise) {
    executor.execute { try {
      val source = file("backups", name); require(source.isFile)
      val copy = file("transfers", "${UUID.randomUUID()}.sqlite"); source.copyTo(copy)
      val result = descriptor(copy, "transfers"); result.putString("displayName", name); promise.resolve(result)
    } catch (error: Exception) { promise.reject("LOCAL_FILE", error.message, error) } }
  }
  @ReactMethod fun removeTransfer(name: String, promise: Promise) {
    executor.execute { try { val f = file("transfers", name); f.delete(); File(f.path + "-wal").delete(); File(f.path + "-shm").delete(); promise.resolve(null) }
      catch (error: Exception) { promise.reject("LOCAL_FILE", error.message, error) } }
  }
}
class LocalFilesPackage : com.facebook.react.ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> = listOf(LocalFilesModule(context))
  override fun createViewManagers(context: ReactApplicationContext): List<com.facebook.react.uimanager.ViewManager<*, *>> = emptyList()
}
