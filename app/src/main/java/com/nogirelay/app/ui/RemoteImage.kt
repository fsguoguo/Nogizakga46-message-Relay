package com.nogirelay.app.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.content.Context
import android.net.Uri
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import com.nogirelay.app.data.MessageType
import com.nogirelay.app.media.MediaDownloader
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private object RemoteImageMemoryCache {
    private val cache = object : LruCache<String, Bitmap>(16 * 1024) {
        override fun sizeOf(key: String, value: Bitmap): Int =
            (value.allocationByteCount / 1024).coerceAtLeast(1)
    }

    @Synchronized
    fun get(key: String): Bitmap? = cache.get(key)

    @Synchronized
    fun put(key: String, bitmap: Bitmap) {
        cache.put(key, bitmap)
    }
}

@Composable
fun RemoteImage(
    url: String?,
    contentDescription: String?,
    modifier: Modifier = Modifier,
    contentScale: ContentScale = ContentScale.Crop,
    loadCachedImmediately: Boolean = false,
    preserveAspectRatio: Boolean = false,
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    var bitmap by remember(url) {
        mutableStateOf(
            url?.let { value ->
                RemoteImageMemoryCache.get(value)
                    ?: if (loadCachedImmediately) loadCachedBitmap(context, value) else null
            },
        )
    }
    LaunchedEffect(url) {
        if (bitmap == null) {
            bitmap = url?.let { value ->
                loadBitmap(context, value)?.also { loaded -> RemoteImageMemoryCache.put(value, loaded) }
            }
        }
    }

    Box(modifier.background(Color(0xFFE7E2EA))) {
        val image = bitmap
        if (image != null) {
            val imageModifier = if (preserveAspectRatio && image.height > 0) {
                Modifier
                    .fillMaxWidth()
                    .aspectRatio(image.width.toFloat() / image.height.toFloat())
            } else {
                Modifier.fillMaxSize()
            }
            Image(
                bitmap = image.asImageBitmap(),
                contentDescription = contentDescription,
                contentScale = contentScale,
                modifier = imageModifier,
            )
        }
    }
}

private fun loadCachedBitmap(context: Context, url: String): Bitmap? = runCatching {
    val uri = Uri.parse(url)
    val bitmap = if (uri.scheme in setOf("android.resource", "content", "file")) {
        context.contentResolver.openInputStream(uri)?.use(BitmapFactory::decodeStream)
    } else if (uri.scheme == "https") {
        MediaDownloader.cachedFileForUrl(context, url, MessageType.IMAGE)
            ?.let { BitmapFactory.decodeFile(it.absolutePath) }
    } else {
        null
    }
    bitmap?.also { RemoteImageMemoryCache.put(url, it) }
}.getOrNull()

private suspend fun loadBitmap(context: Context, url: String): Bitmap? = withContext(Dispatchers.IO) {
    runCatching {
        val uri = Uri.parse(url)
        if (uri.scheme in setOf("android.resource", "content", "file")) {
            context.contentResolver.openInputStream(uri)?.use(BitmapFactory::decodeStream)
        } else if (uri.scheme == "https") {
            val cached = MediaDownloader.cachedFileForUrl(context, url, MessageType.IMAGE)
            val file = cached ?: MediaDownloader.downloadUrl(context, url, MessageType.IMAGE)
            BitmapFactory.decodeFile(file.absolutePath)
        } else {
            null
        }
    }.getOrNull()
}
