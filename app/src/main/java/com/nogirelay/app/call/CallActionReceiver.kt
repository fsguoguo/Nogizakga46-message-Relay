package com.nogirelay.app.call

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class CallActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val messageId = intent.getStringExtra(IncomingCallNotifier.EXTRA_MESSAGE_ID) ?: return
        when (intent.action) {
            IncomingCallNotifier.ACTION_ANSWER -> {
                val activityIntent = Intent(context, IncomingCallActivity::class.java).apply {
                    putExtra(IncomingCallNotifier.EXTRA_MESSAGE_ID, messageId)
                    putExtra(IncomingCallNotifier.EXTRA_AUTO_ANSWER, true)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                }
                context.startActivity(activityIntent)
            }

            IncomingCallNotifier.ACTION_DECLINE -> {
                IncomingCallNotifier.cancel(context, messageId)
                context.sendBroadcast(Intent(IncomingCallActivity.ACTION_FINISH_CALL).apply {
                    setPackage(context.packageName)
                    putExtra(IncomingCallNotifier.EXTRA_MESSAGE_ID, messageId)
                })
            }
        }
    }
}
