package com.nogirelay.app.data

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

class MessageDatabase(context: Context) : SQLiteOpenHelper(context, DB_NAME, null, DB_VERSION) {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE messages (
                id TEXT PRIMARY KEY,
                member_id TEXT NOT NULL,
                member_name TEXT NOT NULL,
                member_avatar_url TEXT,
                phone_image_url TEXT,
                type TEXT NOT NULL,
                text_content TEXT,
                media_url TEXT,
                thumbnail_url TEXT,
                duration_seconds INTEGER,
                sent_at TEXT NOT NULL,
                incoming_call_from TEXT,
                ringtone_url TEXT,
                is_played INTEGER NOT NULL DEFAULT 0,
                translation TEXT,
                translation_done INTEGER NOT NULL DEFAULT 0,
                received_at INTEGER NOT NULL
            )
            """.trimIndent(),
        )
        db.execSQL("CREATE INDEX idx_messages_sent_at ON messages(sent_at DESC)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 2) {
            db.execSQL("ALTER TABLE messages ADD COLUMN translation TEXT")
            db.execSQL("ALTER TABLE messages ADD COLUMN translation_done INTEGER NOT NULL DEFAULT 0")
        }
        if (oldVersion < 3) {
            // Older builds used test_... IDs, so remove those records during migration.
            db.delete("messages", "id GLOB ?", arrayOf(TEST_MESSAGE_GLOB))
        }
    }

    fun insert(message: RelayMessage): Boolean {
        val values = ContentValues().apply {
            put("id", message.id)
            put("member_id", message.memberId)
            put("member_name", message.memberName)
            put("member_avatar_url", message.memberAvatarUrl)
            put("phone_image_url", message.phoneImageUrl)
            put("type", message.type.name)
            put("text_content", message.text)
            put("media_url", message.mediaUrl)
            put("thumbnail_url", message.thumbnailUrl)
            put("duration_seconds", message.durationSeconds)
            put("sent_at", message.sentAt)
            put("incoming_call_from", message.incomingCallFrom)
            put("ringtone_url", message.ringtoneUrl)
            put("is_played", if (message.isPlayed) 1 else 0)
            put("translation", message.translation)
            put("translation_done", if (message.translationDone) 1 else 0)
            put("received_at", System.currentTimeMillis())
        }
        val inserted = writableDatabase.insertWithOnConflict(
            "messages",
            null,
            values,
            SQLiteDatabase.CONFLICT_IGNORE,
        ) != -1L
        if (!inserted) {
            // A history sync can replace an old direct CDN URL with the
            // protected relay URL without resetting playback state.
            val mediaValues = ContentValues().apply {
                message.mediaUrl?.takeIf { it.isNotBlank() }?.let { put("media_url", it) }
                message.thumbnailUrl?.takeIf { it.isNotBlank() }?.let { put("thumbnail_url", it) }
                message.memberAvatarUrl?.takeIf { it.isNotBlank() }?.let { put("member_avatar_url", it) }
                message.phoneImageUrl?.takeIf { it.isNotBlank() }?.let { put("phone_image_url", it) }
            }
            if (mediaValues.size() > 0) {
                writableDatabase.update("messages", mediaValues, "id = ?", arrayOf(message.id))
            }
        }
        return inserted
    }

    fun latest(limit: Int = 200): List<RelayMessage> {
        val result = mutableListOf<RelayMessage>()
        readableDatabase.query(
            "messages",
            null,
            "id NOT GLOB ?",
            arrayOf(TEST_MESSAGE_GLOB),
            null,
            null,
            "sent_at DESC, received_at DESC",
            limit.coerceIn(1, 500).toString(),
        ).use { cursor ->
            while (cursor.moveToNext()) result += cursor.toMessage()
        }
        return result
    }

    fun messagesForMember(
        memberKey: String,
        searchQuery: String = "",
        limit: Int = 20,
        offset: Int = 0,
    ): List<RelayMessage> {
        val result = mutableListOf<RelayMessage>()
        val filter = memberFilter(memberKey, searchQuery)
        readableDatabase.query(
            "messages",
            null,
            filter.selection,
            filter.arguments,
            null,
            null,
            "sent_at DESC, received_at DESC",
            "${limit.coerceIn(1, 100)} OFFSET ${offset.coerceAtLeast(0)}",
        ).use { cursor ->
            while (cursor.moveToNext()) result += cursor.toMessage()
        }
        return result
    }

    fun countMessagesForMember(memberKey: String, searchQuery: String = ""): Int {
        val filter = memberFilter(memberKey, searchQuery)
        readableDatabase.query(
            "messages",
            arrayOf("COUNT(*)"),
            filter.selection,
            filter.arguments,
            null,
            null,
            null,
        ).use { cursor -> return if (cursor.moveToFirst()) cursor.getInt(0) else 0 }
    }

    fun find(id: String): RelayMessage? {
        readableDatabase.query(
            "messages",
            null,
            "id = ?",
            arrayOf(id),
            null,
            null,
            null,
            "1",
        ).use { cursor -> return if (cursor.moveToFirst()) cursor.toMessage() else null }
    }

    fun markPlayed(id: String) {
        val values = ContentValues().apply { put("is_played", 1) }
        writableDatabase.update("messages", values, "id = ?", arrayOf(id))
    }

    /** Removes transient test messages and returns their IDs for notification cleanup. */
    fun deleteTestMessages(): List<String> {
        val ids = mutableListOf<String>()
        writableDatabase.query(
            "messages",
            arrayOf("id"),
            "id GLOB ?",
            arrayOf(TEST_MESSAGE_GLOB),
            null,
            null,
            null,
        ).use { cursor ->
            while (cursor.moveToNext()) ids += cursor.getString(0)
        }
        if (ids.isNotEmpty()) {
            writableDatabase.delete("messages", "id GLOB ?", arrayOf(TEST_MESSAGE_GLOB))
        }
        return ids
    }

    fun pendingTranslations(limit: Int = 100): List<RelayMessage> {
        val result = mutableListOf<RelayMessage>()
        readableDatabase.query(
            "messages",
            null,
            "id NOT GLOB ? AND translation_done = 0 AND text_content IS NOT NULL AND TRIM(text_content) <> ''",
            arrayOf(TEST_MESSAGE_GLOB),
            null,
            null,
            "sent_at DESC, received_at DESC",
            limit.coerceIn(1, 500).toString(),
        ).use { cursor ->
            while (cursor.moveToNext()) result += cursor.toMessage()
        }
        return result
    }

    fun saveTranslation(id: String, translation: String?) {
        val values = ContentValues().apply {
            put(
                "translation",
                translation
                    ?.replace("%%", "\n")
                    ?.replace("\r\n", "\n")
                    ?.replace('\r', '\n')
                    ?.trim()
                    ?.takeIf { it.isNotEmpty() },
            )
            put("translation_done", 1)
        }
        writableDatabase.update("messages", values, "id = ?", arrayOf(id))
    }

    private fun memberFilter(memberKey: String, searchQuery: String): QueryFilter {
        val clauses = mutableListOf(
            "id NOT GLOB ?",
            "((TRIM(member_id) <> '' AND member_id = ?) OR (TRIM(member_id) = '' AND member_name = ?))",
        )
        val arguments = mutableListOf(TEST_MESSAGE_GLOB, memberKey, memberKey)
        val query = searchQuery.trim()
        if (query.isNotEmpty()) {
            clauses += """
                (
                    COALESCE(text_content, '') LIKE ? ESCAPE '\'
                    OR COALESCE(translation, '') LIKE ? ESCAPE '\'
                    OR member_name LIKE ? ESCAPE '\'
                    OR COALESCE(sent_at, '') LIKE ? ESCAPE '\'
                    OR LOWER(type) LIKE LOWER(?) ESCAPE '\'
                    OR CASE type
                        WHEN 'IMAGE' THEN '图片'
                        WHEN 'AUDIO' THEN '语音'
                        WHEN 'VIDEO' THEN '视频'
                        ELSE '文字'
                    END LIKE ? ESCAPE '\'
                )
            """.trimIndent()
            val pattern = "%${escapeLike(query)}%"
            repeat(6) { arguments += pattern }
        }
        return QueryFilter(clauses.joinToString(" AND "), arguments.toTypedArray())
    }

    private fun escapeLike(value: String): String = value
        .replace("\\", "\\\\")
        .replace("%", "\\%")
        .replace("_", "\\_")

    private data class QueryFilter(val selection: String, val arguments: Array<String>)

    private fun Cursor.toMessage(): RelayMessage = RelayMessage(
        id = getString(getColumnIndexOrThrow("id")),
        memberId = getString(getColumnIndexOrThrow("member_id")),
        memberName = getString(getColumnIndexOrThrow("member_name")),
        memberAvatarUrl = nullableString("member_avatar_url"),
        phoneImageUrl = nullableString("phone_image_url"),
        type = MessageType.valueOf(getString(getColumnIndexOrThrow("type"))),
        text = nullableString("text_content"),
        mediaUrl = nullableString("media_url"),
        thumbnailUrl = nullableString("thumbnail_url"),
        durationSeconds = nullableInt("duration_seconds"),
        sentAt = getString(getColumnIndexOrThrow("sent_at")),
        incomingCallFrom = nullableString("incoming_call_from"),
        ringtoneUrl = nullableString("ringtone_url"),
        isPlayed = getInt(getColumnIndexOrThrow("is_played")) == 1,
        translation = nullableString("translation"),
        translationDone = getInt(getColumnIndexOrThrow("translation_done")) == 1,
    )

    private fun Cursor.nullableString(column: String): String? {
        val index = getColumnIndexOrThrow(column)
        return if (isNull(index)) null else getString(index)
    }

    private fun Cursor.nullableInt(column: String): Int? {
        val index = getColumnIndexOrThrow(column)
        return if (isNull(index)) null else getInt(index)
    }

    companion object {
        private const val DB_NAME = "messages.db"
        private const val DB_VERSION = 3
        private const val TEST_MESSAGE_GLOB = "test[-_]*"
    }
}
