package com.nogirelay.app.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.nogirelay.app.call.IncomingCallNotifier
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
        runCatching { MediaDownloader.enqueueIfNeeded(this, message) }
        TranslationManager.enqueue(this)
        if (!isNew) return

        if (message.shouldRing) IncomingCallNotifier.show(this, message)
        else IncomingCallNotifier.showMessage(this, message)
    }

    private fun resolveMessage(data: Map<String, String>): RelayMessage {
        data["payload"]?.takeIf { it.isNotBlank() }?.let {
            return AppGraph.relayClient.parseMessage(JSONObject(it))
        }
        val messageId = data["message_id"] ?: error("FCM data message has no message_id")
        return AppGraph.relayClient.fetchMessage(AppGraph.settings.read(), messageId)
    }
}
