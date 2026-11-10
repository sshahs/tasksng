package app.tasksng.android.logic

import java.time.DayOfWeek
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.time.temporal.TemporalAdjusters
import java.util.Locale

/** A due (or start, planned …) value in local time. */
data class DueInfo(val date: LocalDateTime, /** false for all-day values */ val hasTime: Boolean) {
    val day: LocalDate get() = date.toLocalDate()
}

private val DATE_ONLY = Regex("""^\d{4}-\d{2}-\d{2}$""")

/** `YYYY-MM-DD` (all day), a UTC instant (`…Z`) or a floating local time. */
fun parseDue(value: String?, zone: ZoneId = ZoneId.systemDefault()): DueInfo? {
    if (value.isNullOrEmpty()) return null
    return runCatching {
        when {
            DATE_ONLY.matches(value) -> DueInfo(LocalDate.parse(value).atStartOfDay(), false)
            value.endsWith("Z") -> DueInfo(LocalDateTime.ofInstant(Instant.parse(value), zone), true)
            else -> DueInfo(LocalDateTime.parse(value), true)
        }
    }.getOrNull()
}

/** The moment a stored value stands for. */
fun instantOf(value: String?, zone: ZoneId = ZoneId.systemDefault()): Instant? {
    if (value.isNullOrEmpty()) return null
    return runCatching {
        if (value.endsWith("Z")) Instant.parse(value) else parseDue(value, zone)?.date?.atZone(zone)?.toInstant()
    }.getOrNull()
}

/** A UTC instant without fractions of a second, like the engine writes them. */
fun iso(instant: Instant): String = instant.truncatedTo(ChronoUnit.SECONDS).toString()

/** The stored form: [time] null means all day. */
fun toDue(day: LocalDate, time: LocalTime?, zone: ZoneId = ZoneId.systemDefault()): String =
    if (time == null) day.toString() else iso(day.atTime(time.withSecond(0).withNano(0)).atZone(zone).toInstant())

fun dueTime(info: DueInfo?): LocalTime? = if (info?.hasTime == true) info.date.toLocalTime() else null

fun daysFromToday(info: DueInfo, now: ZonedDateTime): Long = ChronoUnit.DAYS.between(now.toLocalDate(), info.day)

fun isOverdue(info: DueInfo?, now: ZonedDateTime): Boolean {
    if (info == null) return false
    return if (info.hasTime) info.date.isBefore(now.toLocalDateTime()) else info.day.isBefore(now.toLocalDate())
}

fun isDueToday(info: DueInfo?, now: ZonedDateTime): Boolean = info != null && info.day == now.toLocalDate()

private val EN = Locale.ENGLISH
private val HM = DateTimeFormatter.ofPattern("HH:mm", EN)
private val WEEKDAY = DateTimeFormatter.ofPattern("EEEE", EN)
private val DAY_MONTH = DateTimeFormatter.ofPattern("d MMM", EN)
private val DAY_MONTH_YEAR = DateTimeFormatter.ofPattern("d MMM yyyy", EN)

fun formatTime(t: LocalTime): String = t.format(HM)

/** "Today", "Tomorrow 14:30", "Friday", "12 Oct", "12 Oct 2027". */
fun formatDue(info: DueInfo, now: ZonedDateTime = ZonedDateTime.now()): String {
    val days = daysFromToday(info, now)
    val label = when {
        days == 0L -> "Today"
        days == 1L -> "Tomorrow"
        days == -1L -> "Yesterday"
        days in 2..6 -> info.date.format(WEEKDAY)
        info.date.year == now.year -> info.date.format(DAY_MONTH)
        else -> info.date.format(DAY_MONTH_YEAR)
    }
    return if (info.hasTime) "$label ${info.date.format(HM)}" else label
}

fun formatDayHeading(day: LocalDate, now: ZonedDateTime = ZonedDateTime.now()): String {
    val days = ChronoUnit.DAYS.between(now.toLocalDate(), day)
    return when {
        days == 0L -> "Today"
        days == 1L -> "Tomorrow"
        days in 2..6 -> day.format(WEEKDAY)
        day.year == now.year -> day.format(DateTimeFormatter.ofPattern("EEEE, d MMMM", EN))
        else -> day.format(DateTimeFormatter.ofPattern("EEEE, d MMMM yyyy", EN))
    }
}

fun formatTimestamp(value: String?, zone: ZoneId = ZoneId.systemDefault()): String? {
    val info = parseDue(value, zone) ?: return null
    return info.date.format(DateTimeFormatter.ofPattern(if (info.hasTime) "d MMM yyyy, HH:mm" else "d MMM yyyy", EN))
}

fun nextMonday(day: LocalDate): LocalDate = day.with(TemporalAdjusters.next(DayOfWeek.MONDAY))
fun nextSaturday(day: LocalDate): LocalDate = day.with(TemporalAdjusters.next(DayOfWeek.SATURDAY))

/** "just now", "5 min ago", "3 h ago", "12 Oct, 14:30". */
fun relativeTime(isoTime: String?, now: ZonedDateTime = ZonedDateTime.now()): String {
    val t = instantOf(isoTime, now.zone) ?: return "never"
    val secs = Duration.between(t, now.toInstant()).seconds
    if (secs < 45) return "just now"
    val mins = Math.round(secs / 60.0)
    if (mins < 60) return "$mins min ago"
    val hours = Math.round(mins / 60.0)
    if (hours < 24) return "$hours h ago"
    return LocalDateTime.ofInstant(t, now.zone).format(DateTimeFormatter.ofPattern("d MMM, HH:mm", EN))
}
