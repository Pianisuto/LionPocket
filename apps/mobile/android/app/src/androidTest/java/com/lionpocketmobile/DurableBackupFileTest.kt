package com.lionpocketmobile

import android.database.sqlite.SQLiteDatabase
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class DurableBackupFileTest {
  @Test fun standaloneSQLiteCheckpointSurvivesNewHandlesAndBindsExactBytes() {
    val directory = File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir, "backup-instrumentation-" + UUID.randomUUID()).apply { check(mkdirs()) }
    try {
      val source = File(directory, "source.sqlite")
      SQLiteDatabase.openOrCreateDatabase(source, null).use { db ->
        db.execSQL("CREATE TABLE journal(phase TEXT)"); db.execSQL("INSERT INTO journal VALUES('remote_active')")
        db.execSQL("VACUUM INTO ?", arrayOf(File(directory, "checkpoint.sqlite").path))
      }
      val first = DurableBackupFile.fingerprint(directory, "checkpoint.sqlite", true)
      assertEquals(first.second, DurableBackupFile.fingerprint(directory, "checkpoint.sqlite", false).second)
      SQLiteDatabase.openDatabase(first.first.path, null, SQLiteDatabase.OPEN_READONLY).use { db ->
        db.rawQuery("PRAGMA integrity_check", null).use { cursor -> assertTrue(cursor.moveToFirst()); assertEquals("ok", cursor.getString(0)) }
        db.rawQuery("SELECT phase FROM journal", null).use { cursor -> assertTrue(cursor.moveToFirst()); assertEquals("remote_active", cursor.getString(0)) }
      }
      val bytes = first.first.readBytes(); bytes[bytes.lastIndex] = (bytes.last().toInt() xor 1).toByte(); first.first.writeBytes(bytes)
      assertNotEquals(first.second, DurableBackupFile.fingerprint(directory, "checkpoint.sqlite", false).second)
      assertThrows(IllegalArgumentException::class.java) { DurableBackupFile.fingerprint(directory, "../source.sqlite", false) }
    } finally {directory.deleteRecursively()}
  }
}
