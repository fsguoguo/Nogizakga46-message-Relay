package com.nogirelay.app.notification

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.media.AudioAttributes
import android.net.Uri
import com.nogirelay.app.R

object NotificationChannels {
    const val CALLS = "incoming_calls_v2"
    const val CALL_PREPARING = "incoming_call_prepare_v1"
    const val MESSAGES = "member_messages_v1"
    const val PLAYBACK = "voice_playback_v1"

    fun create(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        val ringtone = Uri.parse("android.resource://${context.packageName}/${R.raw.ringtone}")
        val ringtoneAttributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()

        val calls = NotificationChannel(
            CALLS,
            context.getString(R.string.channel_calls),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = "未播放语音的全屏成员来电"
            lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 500, 350, 500, 350, 900)
            setSound(ringtone, ringtoneAttributes)
            setBypassDnd(false)
        }

        val messages = NotificationChannel(
            MESSAGES,
            context.getString(R.string.channel_messages),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = "文字、图片和视频消息"
            enableVibration(true)
        }

        val playback = NotificationChannel(
            PLAYBACK,
            "语音播放",
            NotificationManager.IMPORTANCE_LOW,
        ).apply { setSound(null, null) }

        val preparing = NotificationChannel(
            CALL_PREPARING,
            "来电准备",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "下载语音资源时的后台状态"
            setSound(null, null)
            enableVibration(false)
            setShowBadge(false)
        }

        manager.createNotificationChannels(listOf(calls, preparing, messages, playback))
    }
}
