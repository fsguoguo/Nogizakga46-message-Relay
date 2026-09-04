package com.nogirelay.app.push

import android.os.Handler
import android.os.Looper
import android.util.Log
import android.content.Intent
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.nogirelay.app.call.IncomingCallNotifier
import com.nogirelay.app.call.IncomingCallPreparationService
import com.nogirelay.app.data.AppGraph
import com.nogirelay.app.data.RelayMessage
import com.nogirelay.app.media.MediaDownloader
import com.nogirelay.app.notification.NotificationChannels
import com.nogirelay.app.translation.TranslationManager
import org.json.JSONObject

class NogiFirebaseMessagingService : FirebaseMessagingService() {
    override fun onCreate() {
        super.onCreate()
        AppGraph.initialize(this)
        NotificationChannels.create(this)
    }

    override fun onNewToken(token: String) {
        AppGraph.initialize(this)
        AppGraph.settings.savePushToken(token)
        PushRegistrar.registerTokenInBackground(this, token)
    }

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        val result = runCatching { resolveMessage(remoteMessage.data) }
        val message = result.getOrNull() ?: return
        val isNew = AppGraph.database.insert(message)
        if (!isNew) return

        if (message.shouldRing) {
            startCallPreparation(message)
        } else {
            IncomingCallNotifier.showMessage(this, message)
            Thread({
                runCatching { MediaDownloader.enqueueIfNeeded(this, message) }
                    .onFailure { error -> Log.w("NogiRelay", "Media prefetch failed for ${message.id}", error) }
            }, "media-prefetch").start()
        }
        TranslationManager.enqueue(this)
    }

    private fun startCallPreparation(message: RelayMessage) {
        val intent = Intent(this, IncomingCallPreparationService::class.java).apply {
            putExtra(IncomingCallNotifier.EXTRA_MESSAGE_ID, message.id)
        }
        runCatching { ContextCompat.startForegroundService(this, intent) }
            .onFailure { error ->
                Log.w("NogiRelay", "Unable to start call preparation service", error)
                // High-priority FCM normally permits the foreground service;
                // retain a best-effort fallback for OEM restrictions.
                Thread({
                    val downloaded = runCatching { MediaDownloader.enqueueIfNeeded(this, message) }.getOrNull()
                    Handler(Looper.getMainLooper()).post {
                        if (downloaded != null) IncomingCallNotifier.show(this, message)
                        else IncomingCallNotifier.showUnavailable(this, message, "语音下载失败，请点击通知重试")
                    }
                }, "call-media-preparation-fallback").start()
            }
    }

    private fun resolveMessage(data: Map<String, String>): RelayMessage {
        data["payload"]?.takeIf { it.isNotBlank() }?.let {
            return AppGraph.relayClient.parseMessage(JSONObject(it))
        }
        val messageId = data["message_id"] ?: error("FCM data message has no message_id")
        return AppGraph.relayClient.fetchMessage(AppGraph.settings.read(), messageId)
    }
}
