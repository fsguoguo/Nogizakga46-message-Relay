package com.nogirelay.app.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val BrandPurple = Color(0xFF7A2A90)
val BrandPurpleDark = Color(0xFF4E175F)
val SignalGreen = Color(0xFF14A46D)
val SignalCoral = Color(0xFFDB4F61)
val SignalCyan = Color(0xFF087E8B)

private val LightColors = lightColorScheme(
    primary = BrandPurple,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFF1DCF5),
    onPrimaryContainer = Color(0xFF2F0B38),
    secondary = SignalCyan,
    onSecondary = Color.White,
    tertiary = SignalGreen,
    background = Color.White,
    surface = Color.White,
    surfaceVariant = Color(0xFFF0EDF2),
    outline = Color(0xFF817882),
    error = SignalCoral,
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFFE3AFE9),
    secondary = Color(0xFF71D5DE),
    tertiary = Color(0xFF5EE0A5),
    background = Color(0xFF171318),
    surface = Color(0xFF211C22),
    error = Color(0xFFFFB2BC),
)

@Composable
fun NogiRelayTheme(darkTheme: Boolean = false, content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        typography = Typography(),
        content = content,
    )
}
