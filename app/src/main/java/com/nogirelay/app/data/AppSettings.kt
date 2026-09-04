package com.nogirelay.app.data

data class AppSettings(
    val relayUrl: String = "",
    val accessToken: String = "",
    val openAiApiKey: String = "",
    val openAiModel: String = "gpt-4o-mini",
    val translationEnabled: Boolean = false,
)
