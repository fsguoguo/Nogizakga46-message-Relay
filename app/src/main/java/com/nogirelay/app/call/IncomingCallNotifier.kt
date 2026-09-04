package com.nogirelay.app.call

import android.app.Notification
import android.app.NotificationManager
import android.app.ActivityManager
import android.app.ActivityOptions
import android.app.PendingIntent
import android.app.Person
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build
import android.util.Log
import com.nogirelay.app.MainActivity
import com.nogirelay.app.R
import com.nogirelay.app.data.RelayMessage
import com.nogirelay.app.notification.NotificationChannels

object IncomingCallNotifier {
    const val EXTRA_MESSAGE_ID = "message_id"
    const val EXTRA_AUTO_ANSWER = "auto_answer"
    const val ACTION_ANSWER = "com.nogirelay.app.ANSWER_CALL"
    const val ACTION_DECLINE = "com.nogirelay.app.DECLINE_CALL"

    fun show(context: Context, message: RelayMessage) {
        val notificationManager = context.getSystemService(NotificationManager::class.java)
        val fullScreenIntent = Intent(context, IncomingCallActivity::class.java).apply {
            putExtra(EXTRA_MESSAGE_ID, message.id)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        val creatorOptions = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ActivityOptions.makeBasic().apply {
                setPendingIntentCreatorBackgroundActivityStartMode(
                    ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED,
                )
            }.toBundle()
        } else {
            null
        }
        val fullScreenPendingIntent = PendingIntent.getActivity(
            context,
            message.id.hashCode(),
            fullScreenIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            creatorOptions,
        )

        val answerIntent = Intent(context, CallActionReceiver::class.java).apply {
            action = ACTION_ANSWER
            putExtra(EXTRA_MESSAGE_ID, message.id)
        }
        val declineIntent = Intent(context, CallActionReceiver::class.java).apply {
            action = ACTION_DECLINE
            putExtra(EXTRA_MESSAGE_ID, message.id)
        }
        val answerPendingIntent = PendingIntent.getBroadcast(
            context,
            message.id.hashCode() + 1,
            answerIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val declinePendingIntent = PendingIntent.getBroadcast(
            context,
            message.id.hashCode() + 2,
            declineIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val builder = Notification.Builder(context, NotificationChannels.CALLS)
            .setSmallIcon(R.drawable.ic_notification_call)
            .setContentTitle(message.incomingCallFrom ?: message.memberName)
            .setContentText("乃木坂46メッセージから着信中")
            .setCategory(Notification.CATEGORY_CALL)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setColor(0xFF7A2A90.toInt())
            .setOngoing(true)
            .setAutoCancel(false)
            .setFullScreenIntent(fullScreenPendingIntent, true)
            .setContentIntent(fullScreenPendingIntent)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val person = Person.Builder()
                .setName(message.incomingCallFrom ?: message.memberName)
                .setImportant(true)
                .setIcon(Icon.createWithResource(context, R.drawable.ic_person))
                .build()
            builder.setStyle(Notification.CallStyle.forIncomingCall(person, declinePendingIntent, answerPendingIntent))
        } else {
            builder.addAction(Notification.Action.Builder(null, "拒绝", declinePendingIntent).build())
            builder.addAction(Notification.Action.Builder(null, "接听", answerPendingIntent).build())
        }

        notificationManager.notify(notificationId(message.id), builder.build())

        // Keep the PendingIntent for the system full-screen path and also try
        // a direct launch. The latter covers foreground, locked, and OEM
        // background cases where the notification is delivered but the
        // system delays executing the full-screen PendingIntent.
        val launchedDirectly = runCatching {
            if (isAppInForeground(context)) {
                context.startActivity(fullScreenIntent)
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                val options = ActivityOptions.makeBasic().apply {
                    setPendingIntentCreatorBackgroundActivityStartMode(
                        ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED,
                    )
                    setPendingIntentBackgroundActivityStartMode(
                        ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED,
                    )
                }
                fullScreenPendingIntent.send(context, 0, null, null, null, null, options.toBundle())
            } else {
                context.startActivity(fullScreenIntent)
            }
            true
        }.onFailure { error ->
            Log.w("NogiRelay", "Call activity launch was blocked; keeping notification fallback", error)
        }.getOrDefault(false)
        if (!launchedDirectly) {
            runCatching { fullScreenPendingIntent.send() }
                .onFailure { error -> Log.w("NogiRelay", "PendingIntent call activity fallback was blocked", error) }
        }
    }

    /** Shows a retryable notification without opening the call page prematurely. */
    fun showUnavailable(context: Context, message: RelayMessage, reason: String) {
        val retryIntent = Intent(context, IncomingCallPreparationService::class.java).apply {
            putExtra(EXTRA_MESSAGE_ID, message.id)
        }
        val pendingIntent = PendingIntent.getService(
            context,
            message.id.hashCode(),
            retryIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = Notification.Builder(context, NotificationChannels.CALLS)
            .setSmallIcon(R.drawable.ic_notification_call)
            .setContentTitle(message.incomingCallFrom ?: message.memberName)
            .setContentText(reason)
            .setCategory(Notification.CATEGORY_CALL)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()
        context.getSystemService(NotificationManager::class.java)
            .notify(notificationId(message.id), notification)
    }

    fun showMessage(context: Context, message: RelayMessage) {
        val intent = Intent(context, MainActivity::class.java).apply {
            putExtra(EXTRA_MESSAGE_ID, message.id)
            addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        val contentIntent = PendingIntent.getActivity(
            context,
            message.id.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val label = when (message.type) {
            com.nogirelay.app.data.MessageType.IMAGE -> "发来了一张图片"
            com.nogirelay.app.data.MessageType.AUDIO -> "发来了一条语音"
            com.nogirelay.app.data.MessageType.VIDEO -> "发来了一段视频"
            com.nogirelay.app.data.MessageType.TEXT -> message.text.orEmpty()
        }
        val notification = Notification.Builder(context, NotificationChannels.MESSAGES)
            .setSmallIcon(R.drawable.ic_notification_message)
            .setContentTitle(message.memberName)
            .setContentText(label)
            .setStyle(Notification.BigTextStyle().bigText(label))
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setColor(0xFF7A2A90.toInt())
            .setAutoCancel(true)
            .setContentIntent(contentIntent)
            .build()
        context.getSystemService(NotificationManager::class.java)
            .notify(notificationId(message.id), notification)
    }

    fun cancel(context: Context, messageId: String) {
        context.getSystemService(NotificationManager::class.java).cancel(notificationId(messageId))
    }

    private fun isAppInForeground(context: Context): Boolean {
        val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return false
        return manager.runningAppProcesses
            ?.firstOrNull { it.processName == context.packageName }
            ?.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
    }

    private fun notificationId(messageId: String): Int = 10_000 + (messageId.hashCode() and 0x0FFF_FFFF)
}
