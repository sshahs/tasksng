package app.tasksng.android.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Notes
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.NotificationsNone
import androidx.compose.material.icons.filled.Repeat
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Snooze
import androidx.compose.material.icons.outlined.Event
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.tasksng.android.core.Task
import app.tasksng.android.core.TaskStatus
import app.tasksng.android.logic.Row as TaskRowData
import app.tasksng.android.logic.formatDue
import app.tasksng.android.logic.isDueToday
import app.tasksng.android.logic.isOverdue
import app.tasksng.android.logic.isSnoozed
import app.tasksng.android.logic.parseDue
import app.tasksng.android.logic.snoozeLabel
import java.time.ZonedDateTime

/** The round checkbox of a task, in the colour of its priority. */
@Composable
fun TaskCheck(task: Task, onToggle: () -> Unit, modifier: Modifier = Modifier) {
    val colors = LocalTaskColors.current
    val ring = when {
        task.status == TaskStatus.Completed -> colors.done
        task.status == TaskStatus.Cancelled -> MaterialTheme.colorScheme.outline
        else -> priorityColor(task.priority) ?: MaterialTheme.colorScheme.outline
    }
    val fill by animateColorAsState(if (task.completed) ring else Color.Transparent, label = "check")
    Box(
        modifier
            .size(44.dp)
            .clip(CircleShape)
            .clickable(role = Role.Checkbox, onClick = onToggle)
            .semantics { contentDescription = if (task.completed) "Completed. Reopen" else "Complete" },
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(22.dp).clip(CircleShape).background(fill).border(2.dp, ring, CircleShape), contentAlignment = Alignment.Center) {
            when {
                task.status == TaskStatus.Cancelled -> Icon(Icons.Default.Close, null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.surface)
                task.completed -> Icon(Icons.Default.Check, null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.surface)
                task.status == TaskStatus.InProcess -> Box(Modifier.size(10.dp).clip(CircleShape).background(colors.progress))
            }
        }
    }
}

@Composable
private fun Meta(icon: ImageVector?, text: String?, color: Color = MaterialTheme.colorScheme.onSurfaceVariant) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        if (icon != null) Icon(icon, null, Modifier.size(14.dp), tint = color)
        if (text != null) {
            if (icon != null) Spacer(Modifier.width(3.dp))
            Text(text, style = MaterialTheme.typography.bodySmall, color = color, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@OptIn(ExperimentalFoundationApi::class, ExperimentalLayoutApi::class)
@Composable
fun TaskRow(
    row: TaskRowData,
    listName: String?,
    listColor: Color?,
    collapsed: Boolean,
    now: ZonedDateTime,
    onToggle: () -> Unit,
    onOpen: () -> Unit,
    onMenu: () -> Unit,
    onCollapse: (() -> Unit)?,
    modifier: Modifier = Modifier,
    trailing: (@Composable () -> Unit)? = null,
) {
    val t = row.task
    val due = parseDue(t.due, now.zone)
    val overdue = !t.completed && isOverdue(due, now) && !(due != null && !due.hasTime && isDueToday(due, now))
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Row(
        modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surface)
            .combinedClickable(onClick = onOpen, onLongClick = onMenu)
            .padding(start = (4 + row.depth * 22).dp, end = 8.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TaskCheck(t, onToggle)
        Column(Modifier.weight(1f).padding(vertical = 4.dp)) {
            Text(
                t.summary.ifEmpty { "Untitled task" },
                style = MaterialTheme.typography.bodyLarge,
                color = if (t.completed) muted else MaterialTheme.colorScheme.onSurface,
                textDecoration = if (t.completed) TextDecoration.LineThrough else null,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            val snoozed = !t.completed && isSnoozed(t, now)
            val hasMeta = due != null || t.rrule != null || t.reminders.isNotEmpty() || t.description.isNotBlank() || row.childCount > 0 ||
                t.categories.isNotEmpty() || listName != null || snoozed || t.planned != null || t.status == TaskStatus.InProcess
            if (hasMeta) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(2.dp), modifier = Modifier.padding(top = 2.dp)) {
                    if (t.status == TaskStatus.InProcess) Meta(null, "In progress", LocalTaskColors.current.progress)
                    if (snoozed) Meta(Icons.Default.Snooze, snoozeLabel(t.snoozedUntil!!, now))
                    if (due != null) Meta(Icons.Outlined.Event, formatDue(due, now), if (overdue) LocalTaskColors.current.overdue else muted)
                    if (t.planned != null && !t.completed) parseDue(t.planned, now.zone)?.let { Meta(Icons.Default.Schedule, formatDue(it, now)) }
                    if (t.rrule != null) Meta(Icons.Default.Repeat, null)
                    if (t.reminders.isNotEmpty()) Meta(Icons.Default.NotificationsNone, null)
                    if (t.description.isNotBlank()) Meta(Icons.AutoMirrored.Filled.Notes, null)
                    if (row.childCount > 0) Meta(null, "${row.childDone}/${row.childCount}")
                    for (c in t.categories.take(3)) Meta(null, "#$c", MaterialTheme.colorScheme.primary)
                    if (listName != null) Row(verticalAlignment = Alignment.CenterVertically) {
                        ColorDot(listColor, 7.dp)
                        Spacer(Modifier.width(4.dp))
                        Text(listName, style = MaterialTheme.typography.bodySmall, color = muted, maxLines = 1)
                    }
                }
            }
        }
        if (t.pending) Icon(Icons.Default.CloudOff, "Not synced yet", Modifier.padding(horizontal = 4.dp).size(14.dp), tint = MaterialTheme.colorScheme.outline)
        if (onCollapse != null && (row.hasVisibleChildren || collapsed)) {
            IconButton(onClick = onCollapse) {
                Icon(if (collapsed) Icons.Default.ExpandMore else Icons.Default.ExpandLess, if (collapsed) "Show subtasks" else "Hide subtasks", tint = muted)
            }
        }
        trailing?.invoke()
    }
}

/** A task row that completes when swiped right and asks to snooze when swiped left. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SwipeableTask(onComplete: () -> Unit, onSnooze: () -> Unit, completed: Boolean, enabled: Boolean = true, content: @Composable () -> Unit) {
    val state = rememberSwipeToDismissBoxState(
        confirmValueChange = { value ->
            when (value) {
                SwipeToDismissBoxValue.StartToEnd -> onComplete()
                SwipeToDismissBoxValue.EndToStart -> onSnooze()
                else -> {}
            }
            // The row stays; the list moves it when the task changes.
            false
        },
        positionalThreshold = { it * 0.35f },
    )
    SwipeToDismissBox(
        state = state,
        gesturesEnabled = enabled,
        enableDismissFromEndToStart = !completed,
        backgroundContent = {
            val toEnd = state.dismissDirection == SwipeToDismissBoxValue.StartToEnd
            val color = when (state.dismissDirection) {
                SwipeToDismissBoxValue.StartToEnd -> LocalTaskColors.current.done
                SwipeToDismissBoxValue.EndToStart -> MaterialTheme.colorScheme.tertiary
                else -> Color.Transparent
            }
            Box(Modifier.fillMaxSize().background(color).padding(horizontal = 24.dp), contentAlignment = if (toEnd) Alignment.CenterStart else Alignment.CenterEnd) {
                Icon(if (toEnd) Icons.Default.Check else Icons.Default.Snooze, null, tint = Color.White)
            }
        },
    ) { content() }
}
