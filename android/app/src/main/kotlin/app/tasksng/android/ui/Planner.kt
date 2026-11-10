package app.tasksng.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.DragHandle
import androidx.compose.material.icons.filled.EventBusy
import androidx.compose.material.icons.outlined.TaskAlt
import androidx.compose.material3.AssistChip
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.tasksng.android.core.CalEvent
import app.tasksng.android.core.Task
import app.tasksng.android.core.TaskPatch
import app.tasksng.android.logic.DEFAULT_MINUTES
import app.tasksng.android.logic.STEP
import app.tasksng.android.logic.Slot
import app.tasksng.android.logic.atMinutes
import app.tasksng.android.logic.busyMinutes
import app.tasksng.android.logic.dayRange
import app.tasksng.android.logic.formatDayHeading
import app.tasksng.android.logic.formatMinutes
import app.tasksng.android.logic.layoutSlots
import app.tasksng.android.logic.minutesInto
import app.tasksng.android.logic.nextFreeSlot
import app.tasksng.android.logic.plannedTasks
import app.tasksng.android.logic.snap
import app.tasksng.android.logic.trayTasks
import kotlinx.coroutines.delay
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import kotlin.math.roundToInt

private val HOUR_HEIGHT = 64.dp
private val GUTTER = 52.dp
private const val DAY_END = 18 * 60

private fun clock(minutes: Int): String = "%02d:%02d".format(minutes / 60, minutes % 60)

private sealed interface PlanOverlay {
    data class Block(val id: String) : PlanOverlay
    data class At(val minutes: Int) : PlanOverlay
}

/** A day as a timeline: calendar events next to the tasks planned for a time. */
@Composable
fun PlannerScreen(vm: TasksViewModel) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val zone = remember { ZoneId.systemDefault() }
    var day by remember { mutableStateOf(LocalDate.now(zone)) }
    var now by remember { mutableStateOf(ZonedDateTime.now(zone)) }
    var events by remember { mutableStateOf<List<CalEvent>>(emptyList()) }
    var eventsError by remember { mutableStateOf<String?>(null) }
    var overlay by remember { mutableStateOf<PlanOverlay?>(null) }
    val today = now.toLocalDate()

    LaunchedEffect(Unit) {
        while (true) {
            delay(30_000)
            now = ZonedDateTime.now(zone)
        }
    }
    LaunchedEffect(day, snapshot.lastSync) {
        val (from, to) = dayRange(day, zone)
        events = vm.events(from, to, cachedOnly = true).events
        val fresh = vm.events(from, to, cachedOnly = false)
        events = fresh.events
        eventsError = fresh.error
    }

    val planned = remember(snapshot.tasks, day) { plannedTasks(snapshot.tasks, day, now) }
    val tray = remember(snapshot.tasks, day, today) { trayTasks(snapshot.tasks, day, now) }
    val timed = events.filter { !it.allDay }
    val allDay = events.filter { it.allDay }
    val listColors = remember(snapshot.lists) { snapshot.lists.associate { it.id to parseColor(it.color) } }
    val plannedMinutes = planned.filter { !it.completed }.sumOf { it.plannedMinutes ?: DEFAULT_MINUTES }
    val from = if (day == today) minutesInto(day, now.toInstant(), zone).coerceIn(0, DAY_END) else 8 * 60
    val free = (DAY_END - from - busyMinutes(day, events, planned, from, DAY_END, zone)).coerceAtLeast(0)

    fun suggest(task: Task): Int {
        val start = if (day == today) minutesInto(day, now.toInstant(), zone) else 9 * 60
        return nextFreeSlot(day, events, planned, start, task.plannedMinutes ?: DEFAULT_MINUTES, zone)
    }

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { day = day.minusDays(1) }) { Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, "Day before") }
            Column(Modifier.weight(1f)) {
                Text(formatDayHeading(day, now), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                Text(
                    (if (plannedMinutes > 0) "${formatMinutes(plannedMinutes)} planned" else "Nothing planned") +
                        (if (!day.isBefore(today)) " · ${formatMinutes(free)} free until 18:00" else ""),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (day != today) TextButton(onClick = { day = today }) { Text("Today") }
            IconButton(onClick = { day = day.plusDays(1) }) { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, "Day after") }
        }
        if (allDay.isNotEmpty()) Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for (e in allDay) AssistChip(onClick = {}, label = { Text(e.title) }, leadingIcon = { ColorDot(parseColor(e.color), 8.dp) })
        }
        if (tray.isNotEmpty()) {
            Text(
                if (day == today) "To plan today — tap one" else "Due this day — tap one to plan it",
                Modifier.padding(start = 16.dp, top = 6.dp), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for (t in tray) FilterChip(
                    selected = false,
                    onClick = { vm.plan(t.id, atMinutes(day, suggest(t), zone), t.plannedMinutes ?: DEFAULT_MINUTES) },
                    label = { Text(t.summary.ifEmpty { "Untitled task" }, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(vertical = 2.dp)) },
                    leadingIcon = { ColorDot(priorityColor(t.priority) ?: listColors[t.listId], 8.dp) },
                )
            }
        }
        if (eventsError != null && events.isEmpty()) Row(Modifier.padding(horizontal = 16.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Default.EventBusy, null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.outline)
            Spacer(Modifier.width(6.dp))
            Text("Calendar events couldn't be loaded", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
        }
        HorizontalDivider(Modifier.padding(top = 6.dp))
        Timeline(
            day = day, now = now, zone = zone, events = timed, planned = planned, listColors = listColors,
            onTapSlot = { overlay = PlanOverlay.At(it) },
            onTapBlock = { overlay = PlanOverlay.Block(it) },
            onMove = { t, start -> vm.plan(t.id, atMinutes(day, start, zone), t.plannedMinutes ?: DEFAULT_MINUTES) },
            onResize = { t, minutes -> vm.update(t.id, TaskPatch().plannedMinutes(minutes)) },
            modifier = Modifier.weight(1f),
        )
    }

    when (val o = overlay) {
        is PlanOverlay.Block -> vm.task(o.id)?.let { t ->
            Sheet(t.summary.ifEmpty { "Untitled task" }, { overlay = null }) {
                SheetItem(Icons.Outlined.TaskAlt, if (t.completed) "Reopen" else "Complete") {
                    vm.toggleComplete(t.id)
                    overlay = null
                }
                SheetItem(null, "Open the task") {
                    overlay = null
                    vm.detailId.value = t.id
                }
                Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (m in listOf(15, 30, 45, 60, 90, 120, 180)) FilterChip(
                        selected = (t.plannedMinutes ?: DEFAULT_MINUTES) == m,
                        onClick = { vm.update(t.id, TaskPatch().plannedMinutes(m)) },
                        label = { Text(formatMinutes(m)) },
                    )
                }
                SheetItem(null, "Remove from the plan") {
                    vm.plan(t.id, null, null)
                    overlay = null
                }
            }
        } ?: run { overlay = null }
        is PlanOverlay.At -> Sheet("Plan at ${clock(o.minutes)}", { overlay = null }) {
            if (tray.isEmpty()) Text("Nothing is waiting to be planned for this day.", Modifier.padding(horizontal = 20.dp, vertical = 8.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
            for (t in tray) SheetItem(null, t.summary.ifEmpty { "Untitled task" }) {
                vm.plan(t.id, atMinutes(day, o.minutes, zone), t.plannedMinutes ?: DEFAULT_MINUTES)
                overlay = null
            }
            SheetItem(null, "New task…") {
                overlay = null
                vm.quickAdd.value = QuickAddRequest("${if (day == today) "today" else day.toString()} ${clock(o.minutes)} ")
            }
        }
        null -> {}
    }
}

@Composable
private fun Timeline(
    day: LocalDate,
    now: ZonedDateTime,
    zone: ZoneId,
    events: List<CalEvent>,
    planned: List<Task>,
    listColors: Map<String, Color?>,
    onTapSlot: (Int) -> Unit,
    onTapBlock: (String) -> Unit,
    onMove: (Task, Int) -> Unit,
    onResize: (Task, Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val density = LocalDensity.current
    val pxPerMinute = with(density) { HOUR_HEIGHT.toPx() } / 60f
    val scroll = rememberScrollState()
    val isToday = day == now.toLocalDate()
    val nowMinutes = minutesInto(day, now.toInstant(), zone)
    LaunchedEffect(day) {
        // Start a bit before now (today) or at the start of the working day.
        val target = if (isToday) nowMinutes - 90 else 7 * 60 + 30
        scroll.scrollTo((target.coerceAtLeast(0) * pxPerMinute).roundToInt())
    }

    fun span(e: CalEvent): Pair<Int, Int>? {
        val s = runCatching { Instant.parse(e.start) }.getOrNull() ?: return null
        val end = runCatching { Instant.parse(e.end) }.getOrNull() ?: return null
        val a = minutesInto(day, s, zone).coerceIn(0, 24 * 60)
        val b = minutesInto(day, end, zone).coerceIn(0, 24 * 60)
        return if (b > a || a < 24 * 60) a to maxOf(b, a + STEP) else null
    }
    fun start(t: Task): Int = minutesInto(day, Instant.parse(t.planned), zone)

    val eventSpans = events.mapNotNull { e -> span(e)?.let { e to it } }
    val slots = eventSpans.map { (e, s) -> Slot("e:${e.id}", s.first, s.second) } +
        planned.map { t -> Slot("t:${t.id}", start(t), start(t) + (t.plannedMinutes ?: DEFAULT_MINUTES)) }
    val placement = remember(slots) { layoutSlots(slots) }
    val line = MaterialTheme.colorScheme.outlineVariant
    val currentTap by rememberUpdatedState(onTapSlot)

    BoxWithConstraints(modifier.fillMaxWidth().verticalScroll(scroll)) {
        val laneWidth = maxWidth - GUTTER - 8.dp
        Box(
            Modifier.fillMaxWidth().height(HOUR_HEIGHT * 24).pointerInput(Unit) {
                detectTapGestures { offset -> currentTap(snap((offset.y / pxPerMinute).roundToInt())) }
            },
        ) {
            for (h in 0 until 24) {
                Row(Modifier.offset(y = HOUR_HEIGHT * h).fillMaxWidth().height(HOUR_HEIGHT)) {
                    Text(
                        "%02d:00".format(h), Modifier.width(GUTTER).padding(start = 10.dp).offset(y = (-7).dp),
                        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Box(Modifier.weight(1f).height(1.dp).background(line))
                }
            }
            for ((e, s) in eventSpans) {
                val p = placement["e:${e.id}"] ?: continue
                val color = parseColor(e.color) ?: MaterialTheme.colorScheme.tertiary
                Box(
                    Modifier
                        .offset(x = GUTTER + laneWidth * p.col / p.cols, y = with(density) { (s.first * pxPerMinute).toDp() })
                        .width(laneWidth / p.cols - 3.dp)
                        .height(with(density) { ((s.second - s.first) * pxPerMinute).toDp() } - 2.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(color.copy(alpha = 0.18f)),
                ) {
                    Box(Modifier.width(3.dp).fillMaxSize().background(color))
                    Column(Modifier.padding(start = 9.dp, top = 3.dp, end = 4.dp)) {
                        Text(e.title, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (s.second - s.first >= 45) Text(
                            "${clock(s.first)}–${clock(s.second % (24 * 60))}" + (e.location?.let { " · $it" } ?: ""),
                            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
            for (t in planned) {
                val p = placement["t:${t.id}"] ?: continue
                val minutes = t.plannedMinutes ?: DEFAULT_MINUTES
                var dy by remember(t.id, t.planned) { mutableFloatStateOf(0f) }
                var grow by remember(t.id, t.plannedMinutes) { mutableFloatStateOf(0f) }
                var dragging by remember(t.id) { mutableStateOf(false) }
                val shownStart = if (dragging) snap(start(t) + (dy / pxPerMinute).roundToInt(), minutes) else start(t)
                val shownMinutes = (snap(minutes + (grow / pxPerMinute).roundToInt()).coerceAtLeast(STEP)).let { if (grow == 0f) minutes else it }
                val color = priorityColor(t.priority) ?: listColors[t.listId] ?: MaterialTheme.colorScheme.primary
                val latestMove by rememberUpdatedState(onMove)
                val latestResize by rememberUpdatedState(onResize)
                Surface(
                    color = if (t.completed) MaterialTheme.colorScheme.surfaceContainerHigh else MaterialTheme.colorScheme.primaryContainer,
                    shape = RoundedCornerShape(8.dp),
                    shadowElevation = if (dragging) 6.dp else 0.dp,
                    modifier = Modifier
                        .zIndex(if (dragging) 2f else 1f)
                        .offset(x = GUTTER + laneWidth * p.col / p.cols, y = with(density) { (shownStart * pxPerMinute).toDp() })
                        .width(laneWidth / p.cols - 3.dp)
                        .height((with(density) { (shownMinutes * pxPerMinute).toDp() } - 2.dp).coerceAtLeast(14.dp))
                        .pointerInput(t.id, t.planned) {
                            detectDragGesturesAfterLongPress(
                                onDragStart = { dragging = true },
                                onDragEnd = {
                                    val to = snap(start(t) + (dy / pxPerMinute).roundToInt(), minutes)
                                    dragging = false
                                    dy = 0f
                                    if (to != start(t)) latestMove(t, to)
                                },
                                onDragCancel = {
                                    dragging = false
                                    dy = 0f
                                },
                            ) { change, drag ->
                                change.consume()
                                dy += drag.y
                            }
                        }
                        .clickable { onTapBlock(t.id) },
                ) {
                    Box {
                        Box(Modifier.width(3.dp).fillMaxSize().background(color))
                        Column(Modifier.padding(start = 9.dp, top = 3.dp, end = 22.dp)) {
                            Text(
                                t.summary.ifEmpty { "Untitled task" }, style = MaterialTheme.typography.labelLarge, maxLines = if (shownMinutes >= 60) 2 else 1,
                                overflow = TextOverflow.Ellipsis, textDecoration = if (t.completed) TextDecoration.LineThrough else null,
                            )
                            if (shownMinutes >= 45) Text(
                                "${clock(shownStart)} · ${formatMinutes(shownMinutes)}",
                                style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        // Drag the handle to change how long.
                        Icon(
                            Icons.Default.DragHandle, "Drag to change the length",
                            Modifier.align(Alignment.BottomEnd).size(22.dp).pointerInput(t.id, t.plannedMinutes) {
                                detectDragGestures(
                                    onDragEnd = {
                                        val to = snap(minutes + (grow / pxPerMinute).roundToInt()).coerceAtLeast(STEP)
                                        grow = 0f
                                        if (to != minutes) latestResize(t, to)
                                    },
                                    onDragCancel = { grow = 0f },
                                ) { change, drag ->
                                    change.consume()
                                    grow += drag.y
                                }
                            },
                            tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                        )
                    }
                }
            }
            if (isToday && nowMinutes in 0..(24 * 60)) {
                Row(Modifier.offset(y = with(density) { (nowMinutes * pxPerMinute).toDp() } - 4.dp).zIndex(3f), verticalAlignment = Alignment.CenterVertically) {
                    Spacer(Modifier.width(GUTTER - 4.dp))
                    ColorDot(LocalTaskColors.current.overdue, 8.dp)
                    Box(Modifier.weight(1f).height(1.5.dp).background(LocalTaskColors.current.overdue))
                }
            }
        }
    }
}
