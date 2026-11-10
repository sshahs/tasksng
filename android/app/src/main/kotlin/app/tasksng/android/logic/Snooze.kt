package app.tasksng.android.logic

import app.tasksng.android.core.Task
import java.time.Duration
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale

class SnoozePreset(val id: String, val label: String, /** "18:15", "Sat 09:00". */ val hint: String, val at: ZonedDateTime)

private const val MORNING = 9
private const val EVENING = 19
private fun fmt(p: String) = DateTimeFormatter.ofPattern(p, Locale.ENGLISH)

/** The usual choices, only those that make sense right now. */
fun snoozePresets(now: ZonedDateTime = ZonedDateTime.now()): List<SnoozePreset> {
    val out = mutableListOf<SnoozePreset>()
    var later = now.plusHours(3).withSecond(0).withNano(0)
    val quarter = Math.ceil(later.minute / 15.0).toInt() * 15
    later = later.withMinute(0).plusMinutes(quarter.toLong())
    if (later.toLocalDate() == now.toLocalDate() && later.hour < 21) {
        out += SnoozePreset("later", "Later today", later.format(fmt("HH:mm")), later)
    }
    val today = now.toLocalDate()
    if (now.hour < EVENING - 2) {
        val evening = today.atTime(EVENING, 0).atZone(now.zone)
        out += SnoozePreset("evening", "This evening", evening.format(fmt("HH:mm")), evening)
    }
    val tomorrow = today.plusDays(1).atTime(MORNING, 0).atZone(now.zone)
    out += SnoozePreset("tomorrow", "Tomorrow", tomorrow.format(fmt("EEE HH:mm")), tomorrow)
    if (now.dayOfWeek.value in 1..4) {
        val weekend = nextSaturday(today).atTime(MORNING, 0).atZone(now.zone)
        out += SnoozePreset("weekend", "This weekend", weekend.format(fmt("EEE HH:mm")), weekend)
    }
    val week = nextMonday(today).atTime(MORNING, 0).atZone(now.zone)
    out += SnoozePreset("week", "Next week", week.format(fmt("EEE d MMM")), week)
    return out
}

private fun wake(t: Task): Instant? = t.snoozedUntil?.let { runCatching { Instant.parse(it) }.getOrNull() }

/** Hidden for now: snoozed until a later moment. */
fun isSnoozed(t: Task, now: ZonedDateTime): Boolean = wake(t)?.isAfter(now.toInstant()) == true

/** The next moment a snoozed task comes back, if any. */
fun nextWake(tasks: Iterable<Task>, now: ZonedDateTime): Instant? =
    tasks.asSequence().filter { !it.completed }.mapNotNull(::wake).filter { it.isAfter(now.toInstant()) }.minOrNull()

/** "until 18:15", "until tomorrow 09:00", "until Mon 13 Oct 09:00". */
fun snoozeLabel(until: String, now: ZonedDateTime = ZonedDateTime.now()): String {
    val instant = runCatching { Instant.parse(until) }.getOrNull() ?: return "until later"
    val d = LocalDateTime.ofInstant(instant, now.zone)
    val today = now.toLocalDate()
    return when {
        d.toLocalDate() == today -> "until ${d.format(fmt("HH:mm"))}"
        d.toLocalDate() == today.plusDays(1) -> "until tomorrow ${d.format(fmt("HH:mm"))}"
        Duration.between(now.toInstant(), instant) < Duration.ofDays(6) -> "until ${d.format(fmt("EEE HH:mm"))}"
        else -> "until ${d.format(fmt("EEE d MMM HH:mm"))}"
    }
}
