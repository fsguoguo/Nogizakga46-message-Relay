package com.nogirelay.app.media

import android.Manifest
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import com.nogirelay.app.BuildConfig
import com.nogirelay.app.data.AppGraph
import com.nogirelay.app.data.MessageType
import com.nogirelay.app.data.RelayMessage
import com.nogirelay.app.data.api.ApiConfig
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap

object MediaDownloader {
    private const val MAX_BYTES = 100L * 1024L * 1024L
    private const val CONNECT_TIMEOUT_MS = 15_000
    private const val READ_TIMEOUT_MS = 90_000
    private val locks = ConcurrentHashMap<String, Any>()

    data class SavedDownload(val uri: Uri, val displayName: String)

    /** Kept as a compatibility name for existing call sites. */
    fun enqueue(context: Context, message: RelayMessage): File {
        val mediaUrl = mediaUrlFor(message) ?: error("消息没有可保存的媒体")
        return downloadUrl(context.applicationContext, mediaUrl, message.type)
    }

    /** Downloads a message's media once and returns the private local file. */
    fun enqueueIfNeeded(context: Context, message: RelayMessage): File? {
        val mediaUrl = mediaUrlFor(message) ?: return null
        return downloadUrl(context.applicationContext, mediaUrl, message.type)
    }

    /**
     * Copies a cached/downloaded media file to the system Download directory.
     * Background pre-fetches continue to use the private cache; only an explicit
     * user download calls this method.
     */
    fun saveToDownloads(context: Context, message: RelayMessage): SavedDownload {
        require(message.type != MessageType.TEXT) { "文字消息没有可保存的媒体" }
        if (needsLegacyWritePermission(context)) error("请先允许存储权限")

        val mediaUrl = mediaUrlFor(message) ?: error("消息没有可保存的媒体")
        val source = downloadUrl(context.applicationContext, mediaUrl, message.type)
        val extension = extensionFor(mediaUrl, message.type)
        val displayName = buildDisplayName(message, extension)
        val mimeType = mimeTypeFor(extension, message.type)

        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            saveWithMediaStore(context, source, displayName, mimeType)
        } else {
            saveLegacy(context, source, displayName, mimeType)
        }
    }

    fun needsLegacyWritePermission(context: Context): Boolean =
        Build.VERSION.SDK_INT <= Build.VERSION_CODES.P &&
            context.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED

    fun cachedFileForUrl(context: Context, url: String, type: MessageType): File? {
        val file = cacheFile(context.applicationContext, url, type)
        return file.takeIf { it.isFile && it.length() > 0L }
    }

    /** Returns an existing private file or downloads the URL into one. */
    fun downloadUrl(context: Context, url: String, type: MessageType): File {
        require(url.isNotBlank()) { "媒体地址为空" }
        val appContext = context.applicationContext
        val uri = Uri.parse(url)
        val target = cacheFile(appContext, url, type)
        target.takeIf { it.isFile && it.length() > 0L }?.let { return it }

        val lock = locks.computeIfAbsent(url) { Any() }
        return try {
            synchronized(lock) {
                target.takeIf { it.isFile && it.length() > 0L }?.let { return@synchronized it }
                when (uri.scheme?.lowercase()) {
                    "android.resource", "content", "file" -> copyLocalUri(appContext, uri, target)
                    "https" -> downloadHttps(appContext, uri, target, type)
                    else -> error("不支持的媒体地址")
                }
            }
        } finally {
            locks.remove(url, lock)
        }
    }

    private fun downloadHttps(context: Context, uri: Uri, target: File, type: MessageType): File {
        val connection = (URL(uri.toString()).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            instanceFollowRedirects = true
            doInput = true
            setRequestProperty("Accept", acceptType(type))
            setRequestProperty("User-Agent", "NogiRelay/${BuildConfig.VERSION_NAME}")
            authorizationFor(context, uri.host)?.let { setRequestProperty("Authorization", it) }
        }
        val parent = target.parentFile ?: error("无法创建媒体目录")
        if (!parent.exists() && !parent.mkdirs()) error("无法创建媒体目录")
        val temp = File(parent, "${target.name}.part-${System.nanoTime()}")
        return try {
            val status = connection.responseCode
            if (status !in 200..299) error("媒体服务返回 HTTP $status")
            val contentLength = connection.getHeaderFieldLong("Content-Length", -1L)
            if (contentLength > MAX_BYTES) error("媒体文件超过 100 MB 限制")

            connection.inputStream.use { input ->
                FileOutputStream(temp).use { output ->
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    var total = 0L
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        total += count
                        if (total > MAX_BYTES) error("媒体文件超过 100 MB 限制")
                        output.write(buffer, 0, count)
                    }
                    output.fd.sync()
                }
            }
            replaceAtomically(temp, target)
            target
        } finally {
            connection.disconnect()
            if (temp.exists()) temp.delete()
        }
    }

    private fun copyLocalUri(context: Context, uri: Uri, target: File): File {
        val parent = target.parentFile ?: error("无法创建媒体目录")
        if (!parent.exists() && !parent.mkdirs()) error("无法创建媒体目录")
        val temp = File(parent, "${target.name}.part-${System.nanoTime()}")
        return try {
            context.contentResolver.openInputStream(uri)?.use { input ->
                FileOutputStream(temp).use { output -> input.copyTo(output) }
            } ?: error("无法读取本地媒体")
            replaceAtomically(temp, target)
            target
        } finally {
            if (temp.exists()) temp.delete()
        }
    }

    private fun saveWithMediaStore(
        context: Context,
        source: File,
        displayName: String,
        mimeType: String,
    ): SavedDownload {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, displayName)
            put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
            put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: error("无法在 Download 文件夹创建文件")
        return try {
            resolver.openOutputStream(uri, "w")?.use { output ->
                source.inputStream().use { input -> input.copyTo(output) }
            } ?: error("无法写入 Download 文件夹")
            values.clear()
            values.put(MediaStore.MediaColumns.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            SavedDownload(uri, displayName)
        } catch (error: Throwable) {
            resolver.delete(uri, null, null)
            throw error
        }
    }

    @Suppress("DEPRECATION")
    private fun saveLegacy(
        context: Context,
        source: File,
        displayName: String,
        mimeType: String,
    ): SavedDownload {
        val downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        if (!downloads.exists() && !downloads.mkdirs()) error("无法创建 Download 文件夹")
        val target = uniqueFile(downloads, displayName)
        source.inputStream().use { input ->
            FileOutputStream(target).use { output -> input.copyTo(output) }
        }
        MediaScannerConnection.scanFile(context, arrayOf(target.absolutePath), arrayOf(mimeType), null)
        return SavedDownload(Uri.fromFile(target), target.name)
    }

    private fun uniqueFile(directory: File, displayName: String): File {
        val requested = File(directory, displayName)
        if (!requested.exists()) return requested
        val extension = displayName.substringAfterLast('.', "")
        val baseName = displayName.removeSuffix(if (extension.isEmpty()) "" else ".$extension")
        var index = 2
        while (true) {
            val candidate = File(directory, "$baseName ($index)${if (extension.isEmpty()) "" else ".$extension"}")
            if (!candidate.exists()) return candidate
            index++
        }
    }

    private fun buildDisplayName(message: RelayMessage, extension: String): String {
        val member = message.memberName
            .replace(Regex("[\\\\/:*?\"<>|\\p{Cc}]"), "_")
            .trim()
            .take(40)
            .ifBlank { "NogiRelay" }
        val id = message.id
            .replace(Regex("[^A-Za-z0-9_-]"), "_")
            .takeLast(24)
            .ifBlank { System.currentTimeMillis().toString() }
        return "${member}_$id.$extension"
    }

    private fun mimeTypeFor(extension: String, type: MessageType): String = when (extension.lowercase()) {
        "jpg", "jpeg" -> "image/jpeg"
        "png" -> "image/png"
        "webp" -> "image/webp"
        "gif" -> "image/gif"
        "mp3" -> "audio/mpeg"
        "m4a", "aac" -> "audio/mp4"
        "wav" -> "audio/wav"
        "ogg", "oga" -> "audio/ogg"
        "mp4", "m4v" -> "video/mp4"
        "webm" -> "video/webm"
        else -> acceptType(type)
    }

    private fun replaceAtomically(temp: File, target: File) {
        if (!temp.renameTo(target)) {
            temp.copyTo(target, overwrite = true)
            temp.delete()
        }
    }

    private fun authorizationFor(context: Context, host: String?): String? {
        if (host.isNullOrBlank()) return null
        AppGraph.initialize(context)
        val settings = runCatching { AppGraph.settings.read() }.getOrNull() ?: return null
        val relayUrl = settings.relayUrl.ifBlank { ApiConfig.BASE_URL }
        val relayHost = runCatching { Uri.parse(relayUrl).host }.getOrNull()
        val token = settings.accessToken.ifBlank { ApiConfig.ACCESS_TOKEN }
        return if (relayHost != null && relayHost.equals(host, ignoreCase = true) && token.isNotBlank()) {
            "Bearer $token"
        } else {
            null
        }
    }

    private fun cacheFile(context: Context, url: String, type: MessageType): File {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(url.toByteArray(Charsets.UTF_8))
            .joinToString("") { byte -> "%02x".format(byte) }
        val extension = extensionFor(url, type)
        return File(File(context.filesDir, "media-cache"), "$digest.$extension")
    }

    private fun extensionFor(url: String, type: MessageType): String {
        val path = Uri.parse(url).path.orEmpty()
        val extension = path.substringAfterLast('.', "").lowercase().takeIf {
            it.matches(Regex("[a-z0-9]{2,5}"))
        }
        return extension ?: when (type) {
            MessageType.IMAGE -> "jpg"
            MessageType.AUDIO -> "m4a"
            MessageType.VIDEO -> "mp4"
            MessageType.TEXT -> "bin"
        }
    }

    private fun acceptType(type: MessageType): String = when (type) {
        MessageType.IMAGE -> "image/*"
        MessageType.AUDIO -> "audio/*"
        MessageType.VIDEO -> "video/*"
        MessageType.TEXT -> "application/octet-stream"
    }

    private fun mediaUrlFor(message: RelayMessage): String? =
        message.mediaUrl?.takeIf { it.isNotBlank() }
            ?: if (message.type == MessageType.IMAGE) message.thumbnailUrl?.takeIf { it.isNotBlank() } else null
}
