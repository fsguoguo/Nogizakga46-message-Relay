package com.nogirelay.app.data

import android.net.Uri
import com.nogirelay.app.data.api.ApiConfig
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class RelayClient {
    fun fetchMessages(settings: AppSettings, limit: Int = 200, offset: Int = 0): List<RelayMessage> {
        val baseUrl = settings.relayUrl.ifEmpty { ApiConfig.BASE_URL }
        val token = settings.accessToken.ifEmpty { ApiConfig.ACCESS_TOKEN }

        require(baseUrl.startsWith("https://")) { "同步地址必须使用 HTTPS" }
        require(limit in 1..500) { "同步数量必须在 1 到 500 之间" }
        require(offset >= 0) { "同步偏移量不能为负数" }

        val connection = (URL("${baseUrl.trimEnd('/')}/v1/messages?limit=$limit&offset=$offset").openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 15_000
            readTimeout = 30_000
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Authorization", "Bearer $token")
        }
        return try {
            val status = connection.responseCode
            if (status !in 200..299) error("消息同步服务返回 $status")
            val payload = connection.inputStream.bufferedReader().use { it.readText() }
            val messages = JSONObject(payload).optJSONArray("messages") ?: JSONArray()
            buildList(messages.length()) {
                for (index in 0 until messages.length()) {
                    messages.optJSONObject(index)?.let { add(parseMessage(it)) }
                }
            }
        } finally {
            connection.disconnect()
        }
    }

    fun fetchMessage(settings: AppSettings, messageId: String): RelayMessage {
        // 优先使用 settings 中的配置，如果为空则使用 ApiConfig 默认值
        val baseUrl = settings.relayUrl.ifEmpty { ApiConfig.BASE_URL }
        val token = settings.accessToken.ifEmpty { ApiConfig.ACCESS_TOKEN }

        require(baseUrl.startsWith("https://")) { "同步地址必须使用 HTTPS" }
        val encodedId = Uri.encode(messageId)
        val connection = (URL("${baseUrl.trimEnd('/')}/v1/messages/$encodedId").openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 15_000
            readTimeout = 20_000
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Authorization", "Bearer $token")
        }
        return try {
            val status = connection.responseCode
            if (status !in 200..299) error("消息服务返回 $status")
            val payload = connection.inputStream.bufferedReader().use { it.readText() }
            parseMessage(JSONObject(payload))
        } finally {
            connection.disconnect()
        }
    }

    fun parseMessage(json: JSONObject): RelayMessage {
        fun string(vararg keys: String): String? {
            for (key in keys) {
                val value = json.optString(key, "").trim()
                if (value.isNotEmpty() && value != "null") return value
            }
            return null
        }

        return RelayMessage(
            id = string("id", "message_id") ?: error("消息缺少 id"),
            memberId = string("member_id", "memberId").orEmpty(),
            memberName = string("member_name", "memberName", "incoming_call_from") ?: "乃木坂46",
            memberAvatarUrl = string("member_avatar_url", "memberAvatarUrl", "thumbnail"),
            phoneImageUrl = string("phone_image_url", "phoneImageUrl", "phone_image"),
            type = MessageType.fromWire(string("type", "content_kind", "media_type").orEmpty()),
            text = string("text", "text_content", "original_text"),
            mediaUrl = string("media_url", "mediaUrl", "url"),
            thumbnailUrl = string("thumbnail_url", "thumbnailUrl"),
            durationSeconds = json.optInt("duration_seconds", -1).takeIf { it >= 0 },
            sentAt = string("sent_at", "date_sent", "created_at") ?: "",
            incomingCallFrom = string("incoming_call_from", "incomingCallFrom"),
            ringtoneUrl = string("ringtone_url", "ringtoneUrl", "notification_sound_android"),
            isPlayed = json.optBoolean("is_played", json.optBoolean("isPlayed", false)),
        )
    }
}
