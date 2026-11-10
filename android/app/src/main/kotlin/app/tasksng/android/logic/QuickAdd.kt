package app.tasksng.android.logic

import app.tasksng.android.core.TaskList
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZonedDateTime

data class QuickAddResult(
    val summary: String,
    val due: String? = null,
    val start: String? = null,
    val priority: Int? = null,
    val categories: List<String> = emptyList(),
    val rrule: String? = null,
    /** `@name` — the start of a list's name. */
    val list: String? = null,
    /** The day and time behind [due], for showing what was understood. */
    val dueDay: LocalDate? = null,
    val dueTime: LocalTime? = null,
    val startDay: LocalDate? = null,
)

private const val B = """(^|\s)"""
private const val E = """(?=\s|$)"""

/** Sunday = 0, as in the repeat rules. */
private val WEEKDAYS = mapOf(
    "sun" to 0, "sunday" to 0, "mon" to 1, "monday" to 1, "tue" to 2, "tues" to 2, "tuesday" to 2, "wed" to 3, "wednesday" to 3,
    "thu" to 4, "thur" to 4, "thurs" to 4, "thursday" to 4, "fri" to 5, "friday" to 5, "sat" to 6, "saturday" to 6,
)
private val RRULE_DAY = listOf("SU", "MO", "TU", "WE", "TH", "FR", "SA")
private val WD = WEEKDAYS.keys.sortedByDescending { it.length }.joinToString("|")
private val ORDINAL = mapOf("first" to 1, "1st" to 1, "second" to 2, "2nd" to 2, "third" to 3, "3rd" to 3, "fourth" to 4, "4th" to 4, "last" to -1)
private val SIMPLE_RRULES = mapOf(
    "daily" to "FREQ=DAILY", "every day" to "FREQ=DAILY",
    "weekly" to "FREQ=WEEKLY", "every week" to "FREQ=WEEKLY",
    "monthly" to "FREQ=MONTHLY", "every month" to "FREQ=MONTHLY",
    "yearly" to "FREQ=YEARLY", "every year" to "FREQ=YEARLY",
    "weekdays" to "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "every weekday" to "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
)
private val FREQ = mapOf("day" to "DAILY", "week" to "WEEKLY", "month" to "MONTHLY", "year" to "YEARLY")

/** A day expression: today, tomorrow, next week, in 3 days, fri, next fri, 2026-12-01. */
private val DAY = """(today|tod|tomorrow|tmrw?|next week|next month|in\s+\d{1,3}\s+(?:days?|weeks?|months?)|(?:next\s+)?(?:$WD)|\d{4}-\d{2}-\d{2})"""

private fun re(pattern: String) = Regex(pattern, RegexOption.IGNORE_CASE)

private val RE_EVERY_N = re("""${B}every\s+(\d{1,3}|other)\s+(day|week|month|year)s?$E""")
private val RE_EVERY_ORD = re("""${B}every\s+(first|1st|second|2nd|third|3rd|fourth|4th|last)\s+(weekday|$WD)(?:\s+of\s+the\s+month)?$E""")
private val RE_EVERY_NTH = re("""${B}every\s+(?:month\s+on\s+the\s+)?(\d{1,2})(?:st|nd|rd|th)(?:\s+of\s+the\s+month)?$E""")
private val RE_EVERY_DAYS = re("""${B}every\s+((?:$WD)(?:\s*(?:,|and|&)\s*(?:$WD))*)$E""")
private val RE_SIMPLE = re("""$B(every\s+(?:day|week|month|year|weekday)|daily|weekly|monthly|yearly|weekdays)$E""")
private val RE_PRIORITY = re("""$B(!!!|!!|!(?:[1-3]|high|medium|med|low)?)$E""")
private val RE_TAG = re("""$B#([\p{L}\p{N}_\-/.]+)$E""")
private val RE_LIST = re("""$B@([\p{L}\p{N}_\-/.]+)$E""")
private val RE_FROM_COMPLETION = re("""$B(?:after|from)\s+(?:completion|completing|done)$E""")
private val RE_START = re("""$B(?:from|starting|starts)\s+$DAY$E""")
private val RE_TIME_12 = re("""$B(?:at\s+)?(\d{1,2})(?::([0-5]\d))?\s*(am|pm)$E""")
private val RE_TIME_24 = re("""$B(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)$E""")
private val RE_TIME_WORD = re("""$B(?:at\s+)?(noon|midday|midnight)$E""")
private val RE_DAY = re("""$B(?:on\s+|due\s+)?$DAY$E""")
private val SPLIT_DAYS = Regex("""\s*(?:,|and|&)\s*""")
private val REL = Regex("""^in (\d{1,3}) (days?|weeks?|months?)$""")

/** Cuts the first match out of the text. */
private class Cutter(var text: String) {
    fun take(re: Regex): MatchResult? {
        val m = re.find(text) ?: return null
        text = text.substring(0, m.range.first) + " " + text.substring(m.range.last + 1)
        return m
    }
}

private fun resolveDay(expr: String, today: LocalDate): LocalDate? {
    val w = expr.lowercase().replace(Regex("""\s+"""), " ")
    if (w == "today" || w == "tod") return today
    if (w.startsWith("tom") || w.startsWith("tmr")) return today.plusDays(1)
    if (w == "next week") return nextMonday(today)
    if (w == "next month") return today.plusMonths(1).withDayOfMonth(1)
    REL.find(w)?.let { m ->
        val n = m.groupValues[1].toLong()
        return when {
            m.groupValues[2].startsWith("week") -> today.plusWeeks(n)
            m.groupValues[2].startsWith("month") -> today.plusMonths(n)
            else -> today.plusDays(n)
        }
    }
    if (w.length == 10 && w[4] == '-') return runCatching { LocalDate.parse(w) }.getOrNull()
    val target = WEEKDAYS[w.removePrefix("next ")] ?: return null
    var diff = (target - today.dayOfWeek.value % 7 + 7) % 7
    if (diff == 0) diff = 7
    return today.plusDays(diff.toLong())
}

private fun takeRecurrence(c: Cutter): String? {
    // every 3 days / every 2 weeks / every other month
    c.take(RE_EVERY_N)?.let { m ->
        val n = if (m.groupValues[2].lowercase() == "other") 2 else maxOf(1, m.groupValues[2].toInt())
        return "FREQ=${FREQ.getValue(m.groupValues[3].lowercase())}" + if (n > 1) ";INTERVAL=$n" else ""
    }
    // every last friday / every first weekday (of the month)
    c.take(RE_EVERY_ORD)?.let { m ->
        val ord = ORDINAL.getValue(m.groupValues[2].lowercase())
        val day = m.groupValues[3].lowercase()
        return if (day == "weekday") "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=$ord" else "FREQ=MONTHLY;BYDAY=$ord${RRULE_DAY[WEEKDAYS.getValue(day)]}"
    }
    // every 15th / every month on the 15th
    c.take(RE_EVERY_NTH)?.let { m ->
        val n = m.groupValues[2].toInt()
        if (n in 1..31) return "FREQ=MONTHLY;BYMONTHDAY=$n"
    }
    // every monday / every tue and thu
    c.take(RE_EVERY_DAYS)?.let { m ->
        val days = m.groupValues[2].lowercase().split(SPLIT_DAYS).mapNotNull { WEEKDAYS[it.trim()]?.let(RRULE_DAY::get) }.distinct()
        return "FREQ=WEEKLY;BYDAY=${days.joinToString(",")}"
    }
    c.take(RE_SIMPLE)?.let { m -> return SIMPLE_RRULES[m.groupValues[2].lowercase().replace(Regex("""\s+"""), " ")] }
    return null
}

/**
 * Parses quick-add shortcuts out of a task title:
 * `Pay rent tomorrow 9am !1 #home @personal every month`.
 */
fun parseQuickAdd(input: String, now: ZonedDateTime = ZonedDateTime.now()): QuickAddResult {
    val plain = QuickAddResult(summary = input.trim())
    val c = Cutter(" $input ")
    val today = now.toLocalDate()
    var priority: Int? = null
    var day: LocalDate? = null
    var start: LocalDate? = null
    var time: LocalTime? = null
    val categories = mutableListOf<String>()

    c.take(RE_PRIORITY)?.let { m ->
        val p = m.groupValues[2].lowercase()
        priority = when {
            p == "!!!" || p == "!1" || p == "!high" -> 1
            p == "!!" || p == "!2" || p.startsWith("!med") -> 5
            else -> 9
        }
    }
    while (true) {
        val m = c.take(RE_TAG) ?: break
        if (m.groupValues[2] !in categories) categories += m.groupValues[2]
    }
    val list = c.take(RE_LIST)?.groupValues?.get(2)

    var rrule = takeRecurrence(c)
    if (rrule != null && c.take(RE_FROM_COMPLETION) != null) rrule += ";FROM=COMPLETION"

    c.take(RE_START)?.let { start = resolveDay(it.groupValues[2], today) }

    val t12 = c.take(RE_TIME_12)
    if (t12 != null) {
        var h = t12.groupValues[2].toInt() % 12
        if (t12.groupValues[4].lowercase() == "pm") h += 12
        time = LocalTime.of(h, t12.groupValues[3].ifEmpty { "00" }.toInt())
    } else {
        val t24 = c.take(RE_TIME_24)
        if (t24 != null) time = LocalTime.of(t24.groupValues[2].toInt(), t24.groupValues[3].toInt())
        else c.take(RE_TIME_WORD)?.let { time = if (it.groupValues[2].lowercase() == "midnight") LocalTime.MIDNIGHT else LocalTime.NOON }
    }

    c.take(RE_DAY)?.let { day = resolveDay(it.groupValues[2], today) }

    val summary = c.text.replace(Regex("""\s+"""), " ").trim()
    if (summary.isEmpty()) return plain
    if (day == null && time != null) day = today
    // "every week from monday" starts the series on its start date.
    if (day == null && rrule != null) day = firstOccurrence(rrule, start ?: today)
    return QuickAddResult(
        summary = summary,
        due = day?.let { toDue(it, time, now.zone) },
        start = start?.toString(),
        priority = priority,
        categories = categories,
        rrule = rrule,
        list = list,
        dueDay = day,
        dueTime = time,
        startDay = start,
    )
}

/** Finds the list an `@name` refers to: exact name, then prefix, then any match. */
fun resolveList(token: String?, lists: List<TaskList>): TaskList? {
    if (token.isNullOrEmpty()) return null
    val want = token.lowercase().replace(Regex("[-_.]"), " ")
    fun squash(s: String) = s.lowercase().replace(Regex("""[\s\-_.]+"""), "")
    return lists.firstOrNull { it.name.lowercase() == want }
        ?: lists.firstOrNull { it.name.lowercase().startsWith(want) }
        ?: lists.firstOrNull { squash(it.name).startsWith(squash(token)) }
        ?: lists.firstOrNull { it.name.lowercase().contains(want) }
}
