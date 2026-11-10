package app.tasksng.android.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.LocalFireDepartment
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.tasksng.android.logic.Views
import app.tasksng.android.logic.overview
import java.time.ZonedDateTime
import java.time.format.TextStyle
import java.util.Locale

@Composable
private fun Stat(label: String, value: Int, color: Color, modifier: Modifier = Modifier, onClick: (() -> Unit)? = null) {
    Card(
        modifier = modifier.then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
    ) {
        Column(Modifier.padding(14.dp)) {
            Text(value.toString(), style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold, color = color)
            Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** How things stand: what is due, what got done, and how the last two weeks went. */
@Composable
fun OverviewScreen(vm: TasksViewModel) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val o = remember(snapshot.tasks, snapshot.lists) { overview(snapshot.tasks, snapshot.lists, ZonedDateTime.now()) }
    val colors = LocalTaskColors.current
    val primary = MaterialTheme.colorScheme.primary
    val track = MaterialTheme.colorScheme.surfaceContainerHighest
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)) {
            Row(Modifier.fillMaxWidth().padding(18.dp), verticalAlignment = Alignment.CenterVertically) {
                val total = o.completedToday + o.dueToday + o.overdue
                val fraction = if (total == 0) 0f else o.completedToday / total.toFloat()
                Box(Modifier.size(84.dp), contentAlignment = Alignment.Center) {
                    Canvas(Modifier.fillMaxSize()) {
                        val stroke = Stroke(10.dp.toPx(), cap = StrokeCap.Round)
                        val inset = 5.dp.toPx()
                        val arc = Size(size.width - 2 * inset, size.height - 2 * inset)
                        drawArc(track, 0f, 360f, false, Offset(inset, inset), arc, style = stroke)
                        if (fraction > 0f) drawArc(primary, -90f, 360f * fraction, false, Offset(inset, inset), arc, style = stroke)
                    }
                    Text("${(fraction * 100).toInt()}%", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                }
                Spacer(Modifier.width(18.dp))
                Column {
                    Text(
                        when {
                            total == 0 -> "Nothing due today"
                            o.dueToday + o.overdue == 0 -> "Today is done"
                            else -> "${o.dueToday + o.overdue} to go today"
                        },
                        style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold,
                    )
                    Text("${o.completedToday} completed today · ${o.completedThisWeek} in the last 7 days", style = MaterialTheme.typography.bodyMedium)
                    if (o.streak > 1) Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 4.dp)) {
                        Icon(Icons.Default.LocalFireDepartment, null, Modifier.size(18.dp), tint = colors.medium)
                        Text(" ${o.streak} days in a row", style = MaterialTheme.typography.labelLarge)
                    }
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Stat("Overdue", o.overdue, if (o.overdue > 0) colors.overdue else MaterialTheme.colorScheme.onSurface, Modifier.weight(1f)) { vm.setView(Views.TODAY) }
            Stat("Due today", o.dueToday, MaterialTheme.colorScheme.onSurface, Modifier.weight(1f)) { vm.setView(Views.TODAY) }
            Stat("This week", o.dueThisWeek, MaterialTheme.colorScheme.onSurface, Modifier.weight(1f)) { vm.setView(Views.UPCOMING) }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Stat("Open", o.open, MaterialTheme.colorScheme.onSurface, Modifier.weight(1f)) { vm.setView(Views.ALL) }
            Stat("Snoozed", o.snoozed, MaterialTheme.colorScheme.onSurface, Modifier.weight(1f))
            Stat("Not planned today", o.unplanned, MaterialTheme.colorScheme.onSurface, Modifier.weight(1f)) { vm.setView(Views.PLAN) }
        }
        Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow)) {
            Column(Modifier.fillMaxWidth().padding(16.dp)) {
                Text("Completed, last 14 days", style = MaterialTheme.typography.titleSmall)
                Spacer(Modifier.height(12.dp))
                val max = (o.perDay.maxOfOrNull { it.second } ?: 0).coerceAtLeast(1)
                Row(Modifier.fillMaxWidth().height(96.dp), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.Bottom) {
                    for ((day, n) in o.perDay) Column(Modifier.weight(1f).fillMaxHeight(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Bottom) {
                        if (n > 0) Text(n.toString(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Box(
                            Modifier.fillMaxWidth().height((64 * n / max).coerceAtLeast(if (n > 0) 4 else 2).dp)
                                .clip(RoundedCornerShape(topStart = 4.dp, topEnd = 4.dp)).background(if (n > 0) primary else track),
                        )
                        Text(day.dayOfWeek.getDisplayName(TextStyle.NARROW, Locale.ENGLISH), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
        if (o.byList.isNotEmpty()) Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow)) {
            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Open tasks by list", style = MaterialTheme.typography.titleSmall)
                val max = o.byList.first().second.coerceAtLeast(1)
                for ((list, n) in o.byList) Column(Modifier.clickable { vm.setView(Views.list(list.id)) }) {
                    Row {
                        Text(list.name, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, maxLines = 1)
                        Text(n.toString(), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Box(Modifier.padding(top = 4.dp).fillMaxWidth().height(6.dp).clip(RoundedCornerShape(3.dp)).background(track)) {
                        Box(Modifier.fillMaxWidth(n / max.toFloat()).fillMaxHeight().clip(RoundedCornerShape(3.dp)).background(parseColor(list.color) ?: primary))
                    }
                }
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}
