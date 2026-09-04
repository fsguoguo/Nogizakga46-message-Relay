package com.nogirelay.app.push

import android.content.Context
import android.os.Build
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.nogirelay.app.data.AppGraph
import com.nogirelay.app.data.api.ApiConfig
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

object PushRegistrar {
    fun isConfigured(context: Context): Boolean = FirebaseApp.getApps(context).isNotEmpty()

    fun registerCurrentToken(
        context: Context,
        onComplete: (Result<Unit>) -> Unit = {},
    ) {
        val appContext = context.applicationContext
        AppGraph.initialize(appContext)
        if (!isConfigured(appContext)) {
            onComplete(Result.failure(IllegalStateException("Firebase 尚未配置")))
            return
        }
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            if (!task.isSuccessful || task.result.isNullOrBlank()) {
                onComplete(Result.failure(task.exception ?: IllegalStateException("无法获取 FCM Token")))
                return@addOnCompleteListener
            }
            val token = task.result
            AppGraph.settings.savePushToken(token)
            registerTokenInBackground(appContext, token, onComplete)
        }
    }

    fun registerTokenInBackground(
        context: Context,
        token: String,
        onComplete: (Result<Unit>) -> Unit = {},
    ) {
        Thread({
            val result = runCatching { registerToken(context, token) }
            onComplete(result)
        }, "push-token-registration").start()
    }

    private fun registerToken(context: Context, token: String) {
        AppGraph.initialize(context)
        val settings = AppGraph.settings.read()

        // 优先使用 settings 中的配置，如果为空则使用 ApiConfig 默认值
        val baseUrl = settings.relayUrl.ifEmpty { ApiConfig.BASE_URL }
        val accessToken = settings.accessToken.ifEmpty { ApiConfig.ACCESS_TOKEN }

        require(baseUrl.startsWith("https://")) { "同步服务地址必须使用 HTTPS" }
        require(accessToken.isNotBlank()) { "请先填写访问令牌" }

        val payload = JSONObject()
            .put("token", token)
            .put("platform", "android")
            .put("label", "${Build.MANUFACTURER} ${Build.MODEL}")
            .toString()
            .toByteArray()

        val connection = (URL("${baseUrl.trimEnd('/')}/v1/devices").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 15_000
            readTimeout = 20_000
            doOutput = true
            setFixedLengthStreamingMode(payload.size)
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Authorization", "Bearer $accessToken")
        }
        try {
            connection.outputStream.use { it.write(payload) }
            val status = connection.responseCode
            if (status !in 200..299) error("设备注册失败：HTTP $status")
            connection.inputStream.close()
        } finally {
            connection.disconnect()
        }
    }
}
