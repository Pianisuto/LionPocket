package com.lionpocketmobile

import android.system.Os
import android.system.OsConstants
import android.util.Base64
import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest

/** Closed VACUUM INTO snapshots only. Names resolve inside the app's private backup directory. */
internal object DurableBackupFile {
  fun fingerprint(directory: File, name: String, seal: Boolean): Pair<File, String> {
    require(name.matches(Regex("[a-zA-Z0-9_-][a-zA-Z0-9._-]*\\.sqlite")))
    val source = File(directory, name)
    require(source.isFile && source.canonicalFile.parentFile == directory.canonicalFile)
    if (seal) {
      RandomAccessFile(source, "rw").use { it.fd.sync() }
      val parent = Os.open(directory.absolutePath, OsConstants.O_RDONLY, 0)
      try { Os.fsync(parent) } finally { Os.close(parent) }
    }
    val hash = MessageDigest.getInstance("SHA-256")
    source.inputStream().use { input ->
      val buffer = ByteArray(65536)
      while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        hash.update(buffer, 0, count)
      }
    }
    return Pair(source, Base64.encodeToString(hash.digest(), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING))
  }
}
