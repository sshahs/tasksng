package app.tasksng.android.logic

import app.tasksng.android.core.Reminder
import app.tasksng.android.core.Task
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZonedDateTime
import java.time.temporal.ChronoUnit

private const val MIN = 60L
private const val HOUR = 3600L
private const val DAY = 86_400L
private const val WEEK = 604_800L

private fun plural(n: Long, one: String) = "$n $one${if (n == 1L) "" else "s"}"

/** "15 minutes", "1 hour 30 minutes", "2 days", "1 week" */
fun humanDuration(secs: Long): String {
    val s = Math.abs(secs)
    if (s == 0L) return "0 minutes"
    if (s % WEEK == 0L) return plural(s / WEEK, "week")
    if (s % DAY == 0L) return plural(s / DAY, "day")
    val parts = mutableListOf<String>()
    val d = s / DAY
    val h = s % DAY / HOUR
    val m = s % HOUR / MIN
    if (d > 0) parts += plural(d, "day")
    if (h > 0) parts += plural(h, "hour")
    if (m > 0) parts += plural(m, "minute")
    return parts.joinToString(" ").ifEmpty { plural(s, "second") }
}

private fun pad(n: Long) = n.toString().padStart(2, '0')

/** When a reminder goes off for a task, if that can be worked out. */
fun reminderTime(r: Reminder, due: String?, start: String?, now: ZonedDateTime): LocalDateTime? {
    when (r) {
        is Reminder.At -> return runCatching { LocalDateTime.ofInstant(Instant.parse(r.at), now.zone) }.getOrNull()
        is Reminder.Offset -> {
            val field = if (r.related == "start") start ?: due else due ?: start
            val anchor = parseDue(field, now.zone) ?: return null
            // Whole days are calendar days; for all-day and floating dates the
            // rest is wall-clock time too.
            if (!anchor.hasTime || !field!!.endsWith("Z")) return anchor.date.plusSeconds(r.offset)
            val days = r.offset / DAY
            return anchor.date.atZone(now.zone).plusDays(days).toInstant().plusSeconds(r.offset - days * DAY)
                .let { LocalDateTime.ofInstant(it, now.zone) }
        }
    }
}

fun reminderLabel(r: Reminder, due: String?, start: String?, now: ZonedDateTime = ZonedDateTime.now()): String {
    when (r) {
        is Reminder.At -> return reminderTime(r, due, start, now)?.let { formatDue(DueInfo(it, true), now) } ?: "Reminder"
        is Reminder.Offset -> {
            val onStart = r.related == "start" && start != null
            val anchor = parseDue(if (onStart) start else due ?: start, now.zone)
            if (anchor != null && !anchor.hasTime) {
                // All-day: "On the day at 09:00", "Day before at 09:00", "2 days before at 09:00".
                val days = Math.floorDiv(r.offset, DAY)
                val rest = r.offset - days * DAY
                val time = "${pad(rest / HOUR)}:${pad(rest % HOUR / MIN)}"
                val day = when {
                    days == 0L -> "On the day"
                    days == -1L -> "Day before"
                    days < 0 -> "${-days} days before"
                    else -> "${plural(days, "day")} after"
                }
                return "$day at $time"
            }
            if (r.offset == 0L) return if (onStart) "At start time" else "At due time"
            return "${humanDuration(r.offset)} ${if (r.offset < 0) "before" else "after"}${if (onStart) " start" else ""}"
        }
    }
}

fun reminderLabel(r: Reminder, task: Task, now: ZonedDateTime = ZonedDateTime.now()) = reminderLabel(r, task.due, task.start, now)

class ReminderPreset(val label: String, val reminder: Reminder)

/** Suggestions that fit the task's due date (or fixed times without one). */
fun reminderPresets(due: String?, start: String?, now: ZonedDateTime = ZonedDateTime.now()): List<ReminderPreset> {
    val info = parseDue(due, now.zone)
    fun rel(offset: Long) = Reminder.Offset(offset, "due")
    if (info?.hasTime == true) {
        return listOf(0L, -5 * MIN, -15 * MIN, -30 * MIN, -HOUR, -DAY).map { ReminderPreset(reminderLabel(rel(it), due, start, now), rel(it)) }
    }
    if (info != null) {
        return listOf(9 * HOUR, -15 * HOUR, -2 * DAY + 9 * HOUR, -WEEK + 9 * HOUR).map { ReminderPreset(reminderLabel(rel(it), due, start, now), rel(it)) }
    }
    val today = now.toLocalDate()
    val inAnHour = now.plusHours(2).truncatedTo(ChronoUnit.HOURS)
    val evening = today.atTime(18, 0).atZone(now.zone)
    val tomorrow = today.plusDays(1).atTime(9, 0).atZone(now.zone)
    val monday = nextMonday(today).atTime(9, 0).atZone(now.zone)
    val out = buildList {
        add(inAnHour)
        if (evening.isAfter(inAnHour)) add(evening)
        add(tomorrow)
        if (monday.isAfter(tomorrow)) add(monday)
    }
    return out.map { ReminderPreset(formatDue(DueInfo(it.toLocalDateTime(), true), now), Reminder.At(iso(it.toInstant()))) }
}

fun sameReminder(a: Reminder, b: Reminder): Boolean = when {
    a is Reminder.At && b is Reminder.At -> runCatching { Instant.parse(a.at) == Instant.parse(b.at) }.getOrDefault(a.at == b.at)
    a is Reminder.Offset && b is Reminder.Offset -> a.offset == b.offset && a.related == b.related
    else -> false
}

/** Labels for the automatic reminder setting (`null` offset = off). */
val DEFAULT_REMINDERS: List<Pair<String, Long?>> = listOf(
    "No automatic reminder" to null,
    "At the due time" to 0L,
    "5 minutes before" to -300L,
    "15 minutes before" to -900L,
    "30 minutes before" to -1800L,
    "1 hour before" to -3600L,
)

enum class ReminderUnit(val label: String, val seconds: Long) {
    Minutes("minutes", MIN), Hours("hours", HOUR), Days("days", DAY), Weeks("weeks", WEEK)
}

/**
 * A reminder an amount of time before (or after) the due or start date. For
 * an all-day date only days and weeks make sense, and [timeOfDay] is when on
 * that day it goes off.
 */
fun relativeReminder(amount: Int, unit: ReminderUnit, before: Boolean, related: String, timeOfDay: java.time.LocalTime? = null): Reminder {
    val sign = if (before) -1L else 1L
    val n = maxOf(0, amount).toLong()
    if (timeOfDay == null) return Reminder.Offset(sign * n * unit.seconds, related)
    val days = n * (if (unit == ReminderUnit.Weeks) 7 else 1)
    return Reminder.Offset(sign * days * DAY + timeOfDay.hour * HOUR + timeOfDay.minute * MIN, related)
}
