package com.nogirelay.app.translation

import android.content.Context
import android.util.Log
import com.nogirelay.app.data.AppGraph
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.concurrent.ConcurrentHashMap

/** Queues one local translation attempt per message when the feature is enabled. */
object TranslationManager {
    private const val TAG = "NogiTranslation"
    private const val ENDPOINT = "https://api.openai.com/v1/responses"
    private const val MODELS_ENDPOINT = "https://api.openai.com/v1/models"
    const val DEFAULT_MODEL = "gpt-4o-mini"
    private const val CONNECT_TIMEOUT_MS = 15_000
    private const val READ_TIMEOUT_MS = 60_000

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val inFlight = ConcurrentHashMap.newKeySet<String>()
    private val retryAfter = ConcurrentHashMap<String, Long>()
    private val retryCount = ConcurrentHashMap<String, Int>()
    private val requestSlots = Semaphore(3)

    fun enqueue(context: Context) {
        AppGraph.initialize(context)
        val settings = AppGraph.settings.read()
        if (!settings.translationEnabled || settings.openAiApiKey.isBlank()) return
        val model = settings.openAiModel.trim().takeIf { it.isNotEmpty() } ?: DEFAULT_MODEL

        val pending = runCatching { AppGraph.database.pendingTranslations() }.getOrNull() ?: return
        val now = System.currentTimeMillis()
        pending.forEach { message ->
            if ((retryAfter[message.id] ?: 0L) > now) return@forEach
            if (!inFlight.add(message.id)) return@forEach
            scope.launch {
                try {
                    requestSlots.withPermit {
                        val text = message.text?.trim().orEmpty()
                        if (!shouldTranslate(text)) {
                            AppGraph.database.saveTranslation(message.id, null)
                        } else {
                            val translated = requestTranslation(settings.openAiApiKey, model, text)
                            AppGraph.database.saveTranslation(
                                message.id,
                                normalizeTranslationText(text, translated),
                            )
                        }
                        retryAfter.remove(message.id)
                        retryCount.remove(message.id)
                    }
                } catch (error: Exception) {
                    // Keep translation_done=false so a transient API/network failure can retry later.
                    val attempts = (retryCount.merge(message.id, 1, Int::plus) ?: 1).coerceAtMost(8)
                    val delayMs = (5_000L * (1L shl (attempts - 1))).coerceAtMost(5 * 60_000L)
                    retryAfter[message.id] = System.currentTimeMillis() + delayMs
                    Log.w(TAG, "Translation failed for ${message.id}; retrying in ${delayMs / 1000}s: ${error.message}", error)
                } finally {
                    inFlight.remove(message.id)
                }
            }
        }
    }

    fun resetRetries() {
        retryAfter.clear()
        retryCount.clear()
    }

    /** Fetches chat-capable model ids directly from OpenAI for the current API key. */
    suspend fun fetchAvailableModels(apiKey: String): Result<List<String>> = withContext(Dispatchers.IO) {
        runCatching {
            require(apiKey.isNotBlank()) { "请先填写 OpenAI API Key" }
            val connection = (URL(MODELS_ENDPOINT).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = READ_TIMEOUT_MS
                doInput = true
                setRequestProperty("Accept", "application/json")
                setRequestProperty("Authorization", "Bearer ${apiKey.trim()}")
            }
            try {
                val status = connection.responseCode
                val stream = if (status in 200..299) connection.inputStream else connection.errorStream
                val response = stream?.bufferedReader(StandardCharsets.UTF_8)?.use { it.readText() }.orEmpty()
                if (status !in 200..299) throw IllegalStateException("OpenAI API returned HTTP $status")

                val models = JSONObject(response)
                    .optJSONArray("data")
                    ?.let { data ->
                        buildList {
                            for (index in 0 until data.length()) {
                                val id = data.optJSONObject(index)?.optString("id", "")?.trim().orEmpty()
                                if (isChatModel(id)) add(id)
                            }
                        }
                    }
                    .orEmpty()
                    .distinct()
                    .sortedWith(compareBy<String> { modelSortRank(it) }.thenBy { it })

                if (models.isEmpty()) throw IllegalStateException("账号没有可用的聊天模型")
                models
            } finally {
                connection.disconnect()
            }
        }
    }

    private fun isChatModel(id: String): Boolean {
        val normalized = id.lowercase()
        val chatFamily = normalized.startsWith("gpt-") ||
            normalized.startsWith("chatgpt-") ||
            normalized.startsWith("o1") ||
            normalized.startsWith("o3") ||
            normalized.startsWith("o4")
        val nonChatFamily = listOf(
            "embedding",
            "moderation",
            "whisper",
            "tts",
            "dall-e",
            "image",
        ).any(normalized::contains)
        return chatFamily && !nonChatFamily
    }

    private fun modelSortRank(id: String): Int = when {
        id == DEFAULT_MODEL -> 0
        id == "gpt-4.1-mini" -> 1
        id == "gpt-4.1" -> 2
        id == "gpt-4o" -> 3
        id.startsWith("gpt-") -> 10
        else -> 20
    }

    private fun shouldTranslate(text: String): Boolean {
        if (text.isBlank() || isPureEmojiOrSymbols(text)) return false
        var hasHan = false
        var hasKana = false
        text.codePoints().forEach { codePoint ->
            when (Character.UnicodeScript.of(codePoint)) {
                Character.UnicodeScript.HAN -> hasHan = true
                Character.UnicodeScript.HIRAGANA,
                Character.UnicodeScript.KATAKANA,
                -> hasKana = true
                else -> Unit
            }
        }
        return hasHan || hasKana
    }

    private fun isPureEmojiOrSymbols(text: String): Boolean {
        var hasVisibleSymbol = false
        var hasLetterOrDigit = false
        text.codePoints().forEach { codePoint ->
            if (Character.isWhitespace(codePoint)) return@forEach
            val type = Character.getType(codePoint)
            when {
                Character.isLetterOrDigit(codePoint) -> hasLetterOrDigit = true
                type == Character.FORMAT.toInt() || type == Character.NON_SPACING_MARK.toInt() -> Unit
                type == Character.OTHER_SYMBOL.toInt() || type == Character.MATH_SYMBOL.toInt() -> hasVisibleSymbol = true
                type in punctuationTypes -> hasVisibleSymbol = true
                else -> hasLetterOrDigit = true
            }
        }
        return hasVisibleSymbol && !hasLetterOrDigit
    }

    private suspend fun requestTranslation(apiKey: String, model: String, text: String): String? = withContext(Dispatchers.IO) {
        val request = JSONObject().apply {
            put("model", model)
            put("instructions", SYSTEM_PROMPT)
            put("input", text)
            put("store", false)
        }.toString()

        val connection = (URL(ENDPOINT).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            doInput = true
            doOutput = true
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
            setRequestProperty("Authorization", "Bearer $apiKey")
        }

        try {
            connection.outputStream.use { output ->
                output.write(request.toByteArray(StandardCharsets.UTF_8))
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val response = stream?.bufferedReader(StandardCharsets.UTF_8)?.use { it.readText() }.orEmpty()
            if (status !in 200..299) {
                val detail = runCatching {
                    JSONObject(response).optJSONObject("error")?.optString("message", "")?.trim()
                }.getOrNull().orEmpty()
                throw IllegalStateException(
                    "OpenAI Responses API returned HTTP $status${detail.takeIf { it.isNotEmpty() }?.let { ": $it" } ?: ""}",
                )
            }

            responseOutputText(response)
        } finally {
            connection.disconnect()
        }
    }

    private fun responseOutputText(response: String): String? {
        val json = JSONObject(response)
        json.optString("output_text", "").trim().takeIf { it.isNotEmpty() }?.let { return it }
        val output = json.optJSONArray("output") ?: return null
        val text = buildString {
            for (index in 0 until output.length()) {
                val item = output.optJSONObject(index) ?: continue
                if (item.optString("type") != "message") continue
                val content = item.optJSONArray("content") ?: continue
                for (contentIndex in 0 until content.length()) {
                    val part = content.optJSONObject(contentIndex) ?: continue
                    if (part.optString("type") == "output_text") append(part.optString("text", ""))
                }
            }
        }.trim()
        return text.takeIf { it.isNotEmpty() }
    }

    private val punctuationTypes = setOf(
        Character.CONNECTOR_PUNCTUATION.toInt(),
        Character.DASH_PUNCTUATION.toInt(),
        Character.START_PUNCTUATION.toInt(),
        Character.END_PUNCTUATION.toInt(),
        Character.INITIAL_QUOTE_PUNCTUATION.toInt(),
        Character.FINAL_QUOTE_PUNCTUATION.toInt(),
        Character.OTHER_PUNCTUATION.toInt(),
    )

    private const val SYSTEM_PROMPT = """
You are a professional Simplified Chinese native translator who fluently translates Japanese chat text into Simplified Chinese.

## Translation Rules
1. Output only the translated content, without explanations or additional content such as "Here's the translation".
2. Keep exactly the same number of paragraphs and the same formatting as the original text.
3. Keep proper nouns, names, URLs, code, numbers, emoji, kaomoji, and other content that should not be translated.
4. Preserve line breaks, punctuation, honorific nuance, and the original tone.
5. If the input contains %%, use %% in the output; if it has no %%, do not add %%.
6. If the input is already Chinese, contains only emoji/symbols, or has no translatable Japanese text, return an empty string.

## OUTPUT FORMAT
Single paragraph input: output the translation directly with no separator or extra text.
Multi-paragraph input: use %% as the paragraph separator between translated paragraphs.

Return only the translation.
"""
}
