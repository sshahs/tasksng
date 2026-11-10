package app.tasksng.android.logic

import app.tasksng.android.core.CalEvent
import app.tasksng.android.core.Task
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime

/** How long a task is planned for when nobody said. */
const val DEFAULT_MINUTES = 30
/** Plans snap to quarter hours. */
const val STEP = 15
private const val DAY_MINUTES = 24 * 60

/** The range of a local day as the engine wants it (`from` inclusive, `to` exclusive). */
fun dayRange(day: LocalDate, zone: ZoneId): Pair<String, String> =
    iso(day.atStartOfDay(zone).toInstant()) to iso(day.plusDays(1).atStartOfDay(zone).toInstant())

/** Minutes since local midnight of [day] (may be negative or past the end of the day). */
fun minutesInto(day: LocalDate, at: Instant, zone: ZoneId): Int =
    Math.round(Duration.between(day.atStartOfDay(zone).toInstant(), at).seconds / 60.0).toInt()

/** The instant [minutes] after local midnight of [day]. */
fun atMinutes(day: LocalDate, minutes: Int, zone: ZoneId): Instant = day.atStartOfDay(zone).plusMinutes(minutes.toLong()).toInstant()

/** Nearest quarter hour, kept inside the day so a block always fits. */
fun snap(minutes: Int, duration: Int = 0): Int {
    val s = Math.round(minutes / STEP.toDouble()).toInt() * STEP
    return s.coerceIn(0, DAY_MINUTES - maxOf(duration, STEP))
}

data class Slot(val id: String, val start: Int, val end: Int)
data class Placement(val col: Int, val cols: Int)

/**
 * Side by side placement for overlapping blocks: each gets a column and the
 * number of columns of its group of overlapping blocks.
 */
fun layoutSlots(slots: List<Slot>): Map<String, Placement> {
    val sorted = slots.sortedWith(compareBy<Slot> { it.start }.thenByDescending { it.end }.thenBy { it.id })
    val out = HashMap<String, Placement>()
    var group = mutableListOf<Pair<String, Int>>()
    var colEnds = mutableListOf<Int>()
    var groupEnd = Int.MIN_VALUE
    fun flush() {
        for ((id, col) in group) out[id] = Placement(col, colEnds.size)
        group = mutableListOf()
        colEnds = mutableListOf()
    }
    for (s in sorted) {
        val end = maxOf(s.end, s.start + STEP)
        if (s.start >= groupEnd) {
            flush()
            groupEnd = Int.MIN_VALUE
        }
        var col = colEnds.indexOfFirst { it <= s.start }
        if (col < 0) {
            col = colEnds.size
            colEnds.add(end)
        } else colEnds[col] = end
        group.add(s.id to col)
        groupEnd = maxOf(groupEnd, end)
    }
    flush()
    return out
}

/** Tasks waiting to be planned on [day]: today's tasks for today, otherwise those due or starting then. */
fun trayTasks(all: List<Task>, day: LocalDate, now: ZonedDateTime): List<Task> {
    val today = day == now.toLocalDate()
    fun forDay(t: Task): Boolean {
        if (today) return isInView(Views.TODAY, t, now)
        return parseDue(t.due, now.zone)?.day == day || parseDue(t.start, now.zone)?.day == day
    }
    fun rank(t: Task): Int {
        val due = parseDue(t.due, now.zone)
        return if (isOverdue(due, now) && !isDueToday(due, now)) 0 else 1
    }
    return all
        .filter { !it.completed && !isSnoozed(it, now) && !plannedOn(it, day, now) && !(today && startsLater(it, now)) && forDay(it) }
        .sortedWith(
            compareBy<Task> { rank(it) }
                .thenBy { if (it.priority == 0) 10 else it.priority }
                .thenBy { instantOf(it.due, now.zone)?.toEpochMilli() ?: Long.MAX_VALUE }
                .thenBy { it.summary },
        )
}

/** Tasks planned on [day], in time order. */
fun plannedTasks(all: List<Task>, day: LocalDate, now: ZonedDateTime): List<Task> =
    all.filter { plannedOn(it, day, now) }.sortedBy { it.planned ?: "" }

/** Minutes from [from] to [to] (clipped to the day) taken by timed events and open planned tasks. */
fun busyMinutes(day: LocalDate, events: List<CalEvent>, tasks: List<Task>, from: Int, to: Int, zone: ZoneId): Int {
    val spans = mutableListOf<Pair<Int, Int>>()
    for (e in events) {
        if (e.allDay) continue
        val s = runCatching { Instant.parse(e.start) }.getOrNull() ?: continue
        val end = runCatching { Instant.parse(e.end) }.getOrNull() ?: continue
        spans += minutesInto(day, s, zone) to minutesInto(day, end, zone)
    }
    for (t in tasks) {
        if (t.completed) continue
        val at = t.planned?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: continue
        val s = minutesInto(day, at, zone)
        spans += s to s + (t.plannedMinutes ?: DEFAULT_MINUTES)
    }
    spans.sortBy { it.first }
    var busy = 0
    var cursor = from
    for ((s, e) in spans) {
        val start = maxOf(s, cursor)
        val end = minOf(e, to)
        if (end > start) {
            busy += end - start
            cursor = end
        }
    }
    return busy
}

/** The first quarter hour from [from] on with [duration] minutes free of events and plans. */
fun nextFreeSlot(day: LocalDate, events: List<CalEvent>, tasks: List<Task>, from: Int, duration: Int, zone: ZoneId): Int {
    var start = snap(Math.ceil(from / STEP.toDouble()).toInt() * STEP, duration)
    while (start + duration <= DAY_MINUTES) {
        if (busyMinutes(day, events, tasks, start, start + duration, zone) == 0) return start
        start += STEP
    }
    return snap(from, duration)
}

/** "1 h 30 min", "45 min". */
fun formatMinutes(m: Int): String {
    val h = m / 60
    val rest = m % 60
    return when {
        h == 0 -> "$rest min"
        rest == 0 -> "$h h"
        else -> "$h h $rest min"
    }
}
