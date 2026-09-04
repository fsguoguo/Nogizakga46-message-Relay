package com.nogirelay.app.data

import android.content.Context

object AppGraph {
    @Volatile
    private var initialized = false

    lateinit var settings: SettingsStore
        private set
    lateinit var database: MessageDatabase
        private set
    lateinit var relayClient: RelayClient
        private set

    fun initialize(context: Context) {
        if (initialized) return
        synchronized(this) {
            if (initialized) return
            val appContext = context.applicationContext
            settings = SettingsStore(appContext)
            database = MessageDatabase(appContext)
            relayClient = RelayClient()
            initialized = true
        }
    }
}
