package com.nogirelay.app.call

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.os.Build
import android.os.Bundle
import android.view.WindowInsets
import android.view.WindowInsetsController
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.VolumeUp
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import com.nogirelay.app.R
import com.nogirelay.app.data.AppGraph
import com.nogirelay.app.data.RelayMessage
import com.nogirelay.app.media.VoicePlaybackService
import com.nogirelay.app.ui.NogiRelayTheme
import com.nogirelay.app.ui.RemoteImage

class IncomingCallActivity : ComponentActivity() {
    private var ringtonePlayer: MediaPlayer? = null
    private lateinit var message: RelayMessage

    private val finishReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val targetId = intent?.getStringExtra(IncomingCallNotifier.EXTRA_MESSAGE_ID)
            if (targetId == null || targetId == message.id) finishCall()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        AppGraph.initialize(this)
        configureLockScreen()
        message = resolveMessage(intent) ?: run {
            finish()
            return
        }
        registerFinishReceiver()
        val autoAnswer = intent.getBooleanExtra(IncomingCallNotifier.EXTRA_AUTO_ANSWER, false)
        if (!autoAnswer) startRingtone()

        setContent {
            NogiRelayTheme(darkTheme = true) {
                var state by remember { mutableStateOf(if (autoAnswer) CallState.PLAYING else CallState.RINGING) }

                fun answer() {
                    if (state != CallState.RINGING) return
                    state = CallState.CONNECTING
                    stopRingtone()
                    IncomingCallNotifier.cancel(this@IncomingCallActivity, message.id)
                    AppGraph.database.markPlayed(message.id)
                    startService(
                        Intent(this@IncomingCallActivity, VoicePlaybackService::class.java).apply {
                            action = VoicePlaybackService.ACTION_PLAY
                            putExtra(VoicePlaybackService.EXTRA_MESSAGE_ID, message.id)
                        },
                    )
                    state = CallState.PLAYING
                }

                LaunchedEffect(autoAnswer) {
                    if (autoAnswer) {
                        stopRingtone()
                        AppGraph.database.markPlayed(message.id)
                        startService(
                            Intent(this@IncomingCallActivity, VoicePlaybackService::class.java).apply {
                                action = VoicePlaybackService.ACTION_PLAY
                                putExtra(VoicePlaybackService.EXTRA_MESSAGE_ID, message.id)
                            },
                        )
                    }
                }

                BackHandler { decline() }
                IncomingCallScreen(
                    message = message,
                    state = state,
                    onAnswer = ::answer,
                    onDecline = ::decline,
                )
            }
        }
        hideSystemBarsWhenReady()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.getBooleanExtra(IncomingCallNotifier.EXTRA_AUTO_ANSWER, false)) {
            stopRingtone()
        }
    }

    override fun onDestroy() {
        stopRingtone()
        runCatching { unregisterReceiver(finishReceiver) }
        super.onDestroy()
    }

    private fun resolveMessage(intent: Intent): RelayMessage? {
        val messageId = intent.getStringExtra(IncomingCallNotifier.EXTRA_MESSAGE_ID) ?: return null
        return AppGraph.database.find(messageId)
    }

    private fun configureLockScreen() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
            )
        }
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    private fun hideSystemBarsWhenReady() {
        window.decorView.post {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                window.insetsController?.apply {
                    hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
                    systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                }
            } else {
                @Suppress("DEPRECATION")
                window.decorView.systemUiVisibility =
                    android.view.View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                        android.view.View.SYSTEM_UI_FLAG_FULLSCREEN or
                        android.view.View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            }
        }
    }

    private fun registerFinishReceiver() {
        val filter = IntentFilter(ACTION_FINISH_CALL)
        ContextCompat.registerReceiver(
            this,
            finishReceiver,
            filter,
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
    }

    private fun startRingtone() {
        ringtonePlayer = runCatching {
            MediaPlayer().apply {
            setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build(),
            )
                resources.openRawResourceFd(R.raw.ringtone).use { descriptor ->
                    setDataSource(descriptor.fileDescriptor, descriptor.startOffset, descriptor.length)
                }
                isLooping = true
                prepare()
                start()
            }
        }.getOrNull()
    }

    private fun stopRingtone() {
        ringtonePlayer?.runCatching { stop() }
        ringtonePlayer?.release()
        ringtonePlayer = null
    }

    private fun decline() {
        IncomingCallNotifier.cancel(this, message.id)
        startService(
            Intent(this, VoicePlaybackService::class.java)
                .setAction(VoicePlaybackService.ACTION_STOP),
        )
        finishCall()
    }

    private fun finishCall() {
        stopRingtone()
        if (message.isTestMessage) {
            AppGraph.database.deleteTestMessages()
        }
        finishAndRemoveTask()
    }

    companion object {
        const val ACTION_FINISH_CALL = "com.nogirelay.app.FINISH_CALL"
    }
}

private enum class CallState { RINGING, CONNECTING, PLAYING }

@Composable
private fun IncomingCallScreen(
    message: RelayMessage,
    state: CallState,
    onAnswer: () -> Unit,
    onDecline: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxSize().background(Color.White)) {
        Box(modifier = Modifier.fillMaxWidth().weight(1f).background(Color(0xFF3D2642))) {
            RemoteImage(
                url = message.phoneImageUrl ?: message.memberAvatarUrl,
                contentDescription = message.memberName,
                modifier = Modifier.fillMaxSize(),
                contentScale = ContentScale.Crop,
                loadCachedImmediately = true,
            )
        }

        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth().height(132.dp).background(Color.White),
        ) {
            if (state == CallState.RINGING) {
                Box(contentAlignment = Alignment.Center, modifier = Modifier.weight(1f)) {
                    CallCircleButton(
                        color = Color(0xFFFF6F70),
                        icon = {
                            Icon(
                                painterResource(R.drawable.ic_phone_down_official),
                                contentDescription = "挂断",
                                tint = Color.White,
                                modifier = Modifier.size(30.dp),
                            )
                        },
                        onClick = onDecline,
                    )
                }
                CallIdentity(
                    name = message.incomingCallFrom ?: message.memberName,
                    status = "来电…",
                    modifier = Modifier.weight(0.93f),
                )
                Box(contentAlignment = Alignment.Center, modifier = Modifier.weight(1f)) {
                    CallCircleButton(
                        color = Color(0xFF9C27C3),
                        icon = {
                            Icon(
                                painterResource(R.drawable.ic_phone_up_official),
                                contentDescription = "接听",
                                tint = Color.White,
                                modifier = Modifier.size(30.dp),
                            )
                        },
                        onClick = onAnswer,
                    )
                }
            } else {
                Box(contentAlignment = Alignment.Center, modifier = Modifier.weight(1f)) {
                    CallCircleButton(
                        color = Color(0xFFE5E5E5),
                        icon = {
                            Icon(
                                Icons.AutoMirrored.Rounded.VolumeUp,
                                contentDescription = "扬声器",
                                tint = Color(0xFF555158),
                                modifier = Modifier.size(30.dp),
                            )
                        },
                        onClick = {},
                    )
                }
                CallIdentity(
                    name = message.incomingCallFrom ?: message.memberName,
                    status = when (state) {
                        CallState.CONNECTING -> "连接中…"
                        CallState.PLAYING -> "通话中"
                        CallState.RINGING -> "来电…"
                    },
                    modifier = Modifier.weight(0.93f),
                )
                Box(contentAlignment = Alignment.Center, modifier = Modifier.weight(1f)) {
                    CallCircleButton(
                        color = Color(0xFFFF6F70),
                        icon = {
                            Icon(
                                painterResource(R.drawable.ic_phone_down_official),
                                contentDescription = "挂断",
                                tint = Color.White,
                                modifier = Modifier.size(30.dp),
                            )
                        },
                        onClick = onDecline,
                    )
                }
            }
        }
    }
}

@Composable
private fun CallIdentity(name: String, status: String, modifier: Modifier = Modifier) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
        modifier = modifier,
    ) {
        Text(
            text = name,
            color = Color(0xFF3C393D),
            fontSize = 25.sp,
            textAlign = TextAlign.Center,
            maxLines = 1,
        )
        Spacer(Modifier.height(13.dp))
        Text(
            text = status,
            color = Color(0xFF3C393D),
            fontSize = 15.sp,
            textAlign = TextAlign.Center,
            maxLines = 1,
        )
    }
}

@Composable
private fun CallCircleButton(
    color: Color,
    icon: @Composable () -> Unit,
    onClick: () -> Unit,
) {
    IconButton(
        onClick = onClick,
        modifier = Modifier.size(62.dp).background(color, CircleShape),
    ) { icon() }
}
