package app.tasksng.android.ui

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import app.tasksng.android.data.ThemeMode

private val Blue = Color(0xFF2563EB)

private val LightColors = lightColorScheme(
    primary = Blue,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFDCE6FF),
    onPrimaryContainer = Color(0xFF001A4D),
    secondary = Color(0xFF575E71),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFE4E8F5),
    onSecondaryContainer = Color(0xFF141B2C),
    tertiary = Color(0xFF0F766E),
    onTertiary = Color.White,
    tertiaryContainer = Color(0xFFCCF3EC),
    onTertiaryContainer = Color(0xFF00201C),
    error = Color(0xFFDC2626),
    errorContainer = Color(0xFFFDE2E2),
    onErrorContainer = Color(0xFF5F1212),
    background = Color(0xFFFFFFFF),
    onBackground = Color(0xFF18181B),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF18181B),
    surfaceVariant = Color(0xFFEFF1F5),
    onSurfaceVariant = Color(0xFF5B5F6A),
    surfaceContainerLowest = Color(0xFFFFFFFF),
    surfaceContainerLow = Color(0xFFF8F9FB),
    surfaceContainer = Color(0xFFF3F4F7),
    surfaceContainerHigh = Color(0xFFECEEF2),
    surfaceContainerHighest = Color(0xFFE5E7EC),
    outline = Color(0xFF8A8F9C),
    outlineVariant = Color(0xFFDCDFE6),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFF7AA2FF),
    onPrimary = Color(0xFF00256B),
    primaryContainer = Color(0xFF1E3A8A),
    onPrimaryContainer = Color(0xFFDCE6FF),
    secondary = Color(0xFFBFC6DC),
    onSecondary = Color(0xFF293041),
    secondaryContainer = Color(0xFF2A3040),
    onSecondaryContainer = Color(0xFFDCE2F8),
    tertiary = Color(0xFF5EEAD4),
    onTertiary = Color(0xFF003731),
    tertiaryContainer = Color(0xFF115E56),
    onTertiaryContainer = Color(0xFFCCF3EC),
    error = Color(0xFFF87171),
    onError = Color(0xFF450A0A),
    errorContainer = Color(0xFF5F1D1D),
    onErrorContainer = Color(0xFFFDE2E2),
    background = Color(0xFF0D0E10),
    onBackground = Color(0xFFF4F4F5),
    surface = Color(0xFF0D0E10),
    onSurface = Color(0xFFF4F4F5),
    surfaceVariant = Color(0xFF24262C),
    onSurfaceVariant = Color(0xFFA1A1AA),
    surfaceContainerLowest = Color(0xFF08090A),
    surfaceContainerLow = Color(0xFF141518),
    surfaceContainer = Color(0xFF1A1B1F),
    surfaceContainerHigh = Color(0xFF212328),
    surfaceContainerHighest = Color(0xFF2A2C32),
    outline = Color(0xFF7C808B),
    outlineVariant = Color(0xFF33363D),
)

/** Colours with a meaning of their own, the same in every theme. */
@Immutable
data class TaskColors(val high: Color, val medium: Color, val low: Color, val overdue: Color, val done: Color, val progress: Color)

val LocalTaskColors = staticCompositionLocalOf {
    TaskColors(Color(0xFFDC2626), Color(0xFFD97706), Color(0xFF2563EB), Color(0xFFDC2626), Color(0xFF16A34A), Color(0xFF7C3AED))
}

private val AppShapes = Shapes(
    extraSmall = RoundedCornerShape(6.dp),
    small = RoundedCornerShape(10.dp),
    medium = RoundedCornerShape(14.dp),
    large = RoundedCornerShape(20.dp),
    extraLarge = RoundedCornerShape(28.dp),
)

@Composable
fun isDark(mode: ThemeMode): Boolean = when (mode) {
    ThemeMode.System -> isSystemInDarkTheme()
    ThemeMode.Light -> false
    ThemeMode.Dark -> true
}

@Composable
fun TasksTheme(mode: ThemeMode = ThemeMode.System, dynamicColor: Boolean = false, content: @Composable () -> Unit) {
    val dark = isDark(mode)
    val colors = when {
        dynamicColor && Build.VERSION.SDK_INT >= 31 -> if (dark) dynamicDarkColorScheme(LocalContext.current) else dynamicLightColorScheme(LocalContext.current)
        dark -> DarkColors
        else -> LightColors
    }
    val taskColors = if (dark) {
        TaskColors(Color(0xFFF87171), Color(0xFFFBBF24), Color(0xFF7AA2FF), Color(0xFFF87171), Color(0xFF4ADE80), Color(0xFFA78BFA))
    } else {
        TaskColors(Color(0xFFDC2626), Color(0xFFD97706), Color(0xFF2563EB), Color(0xFFDC2626), Color(0xFF16A34A), Color(0xFF7C3AED))
    }
    CompositionLocalProvider(LocalTaskColors provides taskColors) {
        MaterialTheme(colorScheme = colors, shapes = AppShapes, content = content)
    }
}
