package com.nogirelay.app.call

import android.app.Notification
import android.app.Service
import android.content.Intent
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.nogirelay.app.R
import com.nogirelay.app.data.AppGraph
import com.nogirelay.app.media.MediaDownloader
import com.nogirelay.app.notification.NotificationChannels
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Downloads an incoming call audio file before exposing the full-screen call UI. */
class IncomingCallPreparationService : Service() {
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onCreate() {
        super.onCreate()
        AppGraph.initialize(this)
        NotificationChannels.create(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val messageId = intent?.getStringExtra(IncomingCallNotifier.EXTRA_MESSAGE_ID)
        if (messageId.isNullOrBlank()) {
            stopSelfResult(startId)
            return START_NOT_STICKY
        }

        startForeground(PREPARING_NOTIFICATION_ID, preparingNotification())
        serviceScope.launch {
            val message = AppGraph.database.find(messageId)
            if (message == null) {
                stopSelfResult(startId)
                return@launch
            }

            val downloaded = runCatching {
                MediaDownloader.enqueueIfNeeded(this@IncomingCallPreparationService, message)
            }.getOrNull()

            withContext(Dispatchers.Main) {
                if (downloaded != null) {
                    IncomingCallNotifier.show(this@IncomingCallPreparationService, message)
                } else {
                    IncomingCallNotifier.showUnavailable(
                        this@IncomingCallPreparationService,
                        message,
                        "语音下载失败，请点击通知重试",
                    )
                }
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelfResult(startId)
            }
        }
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        serviceScope.cancel()
        super.onDestroy()
    }

    private fun preparingNotification(): Notification =
        NotificationCompat.Builder(this, NotificationChannels.CALL_PREPARING)
            .setSmallIcon(R.drawable.ic_notification_call)
            .setContentTitle("正在下载语音")
            .setContentText("资源准备完成后显示来电")
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setProgress(0, 0, true)
            .build()

    companion object {
        private const val PREPARING_NOTIFICATION_ID = 9_999
    }
}
