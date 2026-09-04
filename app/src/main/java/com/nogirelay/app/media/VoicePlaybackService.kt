package com.nogirelay.app.media

import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.IBinder
import com.nogirelay.app.data.AppGraph
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.File

data class VoicePlaybackState(
    val messageId: String? = null,
    val isPlaying: Boolean = false,
    val positionMs: Int = 0,
    val durationMs: Int = 0,
)

class VoicePlaybackService : Service() {
    private var player: MediaPlayer? = null
    private var focusRequest: AudioFocusRequest? = null
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    override fun onCreate() {
        super.onCreate()
        AppGraph.initialize(this)
        serviceScope.launch {
            while (isActive) {
                publishPlaybackState()
                delay(PROGRESS_UPDATE_INTERVAL_MS)
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopPlayback()
            return START_NOT_STICKY
        }
        if (intent?.action == ACTION_SEEK) {
            val messageId = intent.getStringExtra(EXTRA_MESSAGE_ID)
            val positionMs = intent.getIntExtra(EXTRA_POSITION_MS, -1)
            if (messageId != null && messageId == currentMessageId && positionMs >= 0) {
                player?.runCatching {
                    val duration = duration.takeIf { it > 0 } ?: Int.MAX_VALUE
                    seekTo(positionMs.coerceIn(0, duration))
                }
                publishPlaybackState()
            }
            return START_NOT_STICKY
        }

        val messageId = intent?.getStringExtra(EXTRA_MESSAGE_ID) ?: return START_NOT_STICKY
        val message = AppGraph.database.find(messageId) ?: return START_NOT_STICKY
        if (message.mediaUrl.isNullOrBlank()) return START_NOT_STICKY
        if (currentMessageId == messageId && player != null) {
            val activePlayer = player ?: return START_NOT_STICKY
            val isCurrentlyPlaying = runCatching { activePlayer.isPlaying }.getOrDefault(false)
            if (isCurrentlyPlaying) {
                activePlayer.pause()
                playing = false
            } else {
                runCatching {
                    activePlayer.start()
                    playing = true
                }.onFailure {
                    stopPlayback()
                    return START_NOT_STICKY
                }
            }
            publishPlaybackState()
            return START_NOT_STICKY
        }
        serviceScope.launch {
            val file = runCatching {
                withContext(Dispatchers.IO) {
                    MediaDownloader.enqueueIfNeeded(this@VoicePlaybackService, message)
                }
            }.getOrNull()
            if (file == null) {
                stopPlayback()
                return@launch
            }
            runCatching { play(messageId, file) }
                .onFailure { stopPlayback() }
        }
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        serviceScope.cancel()
        releasePlayer()
        super.onDestroy()
    }

    private fun play(messageId: String, mediaFile: File) {
        releasePlayer()
        currentMessageId = messageId
        playing = false
        publishPlaybackState()
        val audioManager = getSystemService(AudioManager::class.java)
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .setOnAudioFocusChangeListener { change ->
                if (change <= AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
                    player?.runCatching { pause() }
                    playing = false
                    publishPlaybackState()
                }
            }
            .build()
        focusRequest = request
        audioManager.requestAudioFocus(request)

        player = MediaPlayer().apply {
            setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            setDataSource(mediaFile.absolutePath)
            setOnPreparedListener {
                AppGraph.database.markPlayed(messageId)
                it.start()
                playing = true
                publishPlaybackState()
            }
            setOnCompletionListener {
                sendBroadcast(Intent(ACTION_PLAYBACK_FINISHED).setPackage(packageName))
                stopPlayback()
            }
            setOnErrorListener { _, _, _ ->
                stopPlayback()
                true
            }
            prepareAsync()
        }
    }

    private fun stopPlayback() {
        releasePlayer()
        stopSelf()
    }

    private fun publishPlaybackState() {
        val activePlayer = player
        val id = currentMessageId
        if (activePlayer == null || id == null) {
            if (_playbackState.value != VoicePlaybackState()) {
                _playbackState.value = VoicePlaybackState()
            }
            return
        }

        val position = runCatching { activePlayer.currentPosition }.getOrDefault(0).coerceAtLeast(0)
        val duration = runCatching { activePlayer.duration }.getOrDefault(0).coerceAtLeast(0)
        val isPlayingNow = playing && runCatching { activePlayer.isPlaying }.getOrDefault(false)
        val next = VoicePlaybackState(id, isPlayingNow, position, duration)
        if (_playbackState.value != next) _playbackState.value = next
    }

    private fun releasePlayer() {
        player?.runCatching { stop() }
        player?.release()
        player = null
        currentMessageId = null
        playing = false
        _playbackState.value = VoicePlaybackState()
        focusRequest?.let { getSystemService(AudioManager::class.java).abandonAudioFocusRequest(it) }
        focusRequest = null
    }

    companion object {
        const val EXTRA_MESSAGE_ID = "message_id"
        const val ACTION_PLAY = "com.nogirelay.app.PLAY_VOICE"
        const val ACTION_STOP = "com.nogirelay.app.STOP_VOICE"
        const val ACTION_SEEK = "com.nogirelay.app.SEEK_VOICE"
        const val ACTION_PLAYBACK_FINISHED = "com.nogirelay.app.VOICE_FINISHED"
        const val EXTRA_POSITION_MS = "position_ms"
        private const val PROGRESS_UPDATE_INTERVAL_MS = 200L

        private val _playbackState = MutableStateFlow(VoicePlaybackState())
        val playbackState: StateFlow<VoicePlaybackState> = _playbackState.asStateFlow()

        @Volatile
        private var currentMessageId: String? = null

        @Volatile
        private var playing: Boolean = false

        fun isPlaying(messageId: String): Boolean =
            _playbackState.value.messageId == messageId && _playbackState.value.isPlaying

        fun seek(context: Context, messageId: String, positionMs: Int) {
            context.startService(
                Intent(context, VoicePlaybackService::class.java).apply {
                    action = ACTION_SEEK
                    putExtra(EXTRA_MESSAGE_ID, messageId)
                    putExtra(EXTRA_POSITION_MS, positionMs)
                },
            )
        }
    }
}
