package com.nogirelay.app.data

import android.content.Context

class SettingsStore(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun read(): AppSettings = AppSettings(
        relayUrl = prefs.getString(KEY_RELAY_URL, "").orEmpty(),
        accessToken = prefs.getString(KEY_TOKEN, "").orEmpty(),
        openAiApiKey = prefs.getString(KEY_OPENAI_API_KEY, "").orEmpty(),
        openAiModel = prefs.getString(KEY_OPENAI_MODEL, "gpt-4o-mini").orEmpty(),
        translationEnabled = prefs.getBoolean(KEY_TRANSLATION_ENABLED, false),
    )

    fun save(settings: AppSettings) {
        prefs.edit()
            .putString(KEY_RELAY_URL, settings.relayUrl.trim().trimEnd('/'))
            .putString(KEY_TOKEN, settings.accessToken.trim())
            .putString(KEY_OPENAI_API_KEY, settings.openAiApiKey.trim())
            .putString(KEY_OPENAI_MODEL, settings.openAiModel.trim())
            .putBoolean(KEY_TRANSLATION_ENABLED, settings.translationEnabled)
            .apply()
    }

    fun pushToken(): String = prefs.getString(KEY_PUSH_TOKEN, "").orEmpty()

    fun savePushToken(token: String) {
        prefs.edit().putString(KEY_PUSH_TOKEN, token).apply()
    }

    companion object {
        private const val PREFS_NAME = "settings"
        private const val KEY_RELAY_URL = "relay_url"
        private const val KEY_TOKEN = "token"
        private const val KEY_OPENAI_API_KEY = "openai_api_key"
        private const val KEY_OPENAI_MODEL = "openai_model"
        private const val KEY_TRANSLATION_ENABLED = "translation_enabled"
        private const val KEY_PUSH_TOKEN = "push_token"
    }
}
