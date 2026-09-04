package com.nogirelay.app.translation

private val blankLinePattern = Regex("\\n[ \\t]*\\n+")
private val longBlankLinePattern = Regex("\\n{3,}")

/** Normalizes Responses output while retaining the source message's paragraph shape. */
fun normalizeTranslationText(source: String?, translated: String?): String? {
    val value = translated
        ?.replace("%%", "\n")
        ?.replace("\r\n", "\n")
        ?.replace('\r', '\n')
        ?.lines()
        ?.joinToString("\n") { it.trimEnd() }
        ?.trim()
        ?.takeIf { it.isNotEmpty() }
        ?: return null

    val sourceHasBlankParagraph = source
        ?.replace("\r\n", "\n")
        ?.replace('\r', '\n')
        ?.contains(blankLinePattern) == true

    return if (sourceHasBlankParagraph) {
        value.replace(longBlankLinePattern, "\n\n")
    } else {
        value.replace(blankLinePattern, "\n")
    }
}
