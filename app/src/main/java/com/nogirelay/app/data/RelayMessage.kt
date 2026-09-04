package com.nogirelay.app.data

enum class MessageType {
    TEXT,
    IMAGE,
    AUDIO,
    VIDEO;

    companion object {
        fun fromWire(value: String): MessageType = when (value.lowercase()) {
            "image", "picture", "photo" -> IMAGE
            "audio", "voice", "call" -> AUDIO
            "video", "movie" -> VIDEO
            else -> TEXT
        }
    }
}

data class RelayMessage(
    val id: String,
    val memberId: String,
    val memberName: String,
    val memberAvatarUrl: String?,
    val phoneImageUrl: String?,
    val type: MessageType,
    val text: String?,
    val mediaUrl: String?,
    val thumbnailUrl: String?,
    val durationSeconds: Int?,
    val sentAt: String,
    val incomingCallFrom: String?,
    val ringtoneUrl: String?,
    val isPlayed: Boolean,
    val translation: String? = null,
    val translationDone: Boolean = false,
) {
    val isTestMessage: Boolean
        get() = isTestId(id)

    val shouldRing: Boolean
        get() = type == MessageType.AUDIO && !incomingCallFrom.isNullOrBlank()

    companion object {
        fun isTestId(value: String): Boolean = value.startsWith("test-") || value.startsWith("test_")
    }
}
