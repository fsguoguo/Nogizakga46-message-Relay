package com.nogirelay.app.data.api

import com.nogirelay.app.BuildConfig

/**
 * API 配置
 *
 * 部署信息：
 * - 服务器地址：https://nogi-relay.fly.dev
 * - Firebase Project ID：nogizaka46-relay
 *
 * ACCESS_TOKEN 默认为空。开发者可以在客户端设置页输入，或在本机
 * 未提交的 local.properties 中设置 relay.access.token 后构建调试包。
 */
object ApiConfig {
    // Fly.io 部署的服务器地址
    const val BASE_URL = "https://nogi-relay.fly.dev"

    // Optional local build-time value; never commit a real token to source.
    val ACCESS_TOKEN: String
        get() = BuildConfig.RELAY_ACCESS_TOKEN

    // API 版本
    const val API_VERSION = "v1"

    // 超时配置（秒）
    const val CONNECT_TIMEOUT = 30L
    const val READ_TIMEOUT = 30L
    const val WRITE_TIMEOUT = 30L

    // 是否启用日志
    const val ENABLE_LOGGING = true
}
