package app.tasksng.android.logic

import java.time.LocalDate
import java.time.YearMonth
import java.time.format.DateTimeFormatter
import java.util.Locale

/** The parts of an RRULE that the repeat editor understands. */
enum class Freq(val one: String, val many: String) {
    DAILY("day", "days"), WEEKLY("week", "weeks"), MONTHLY("month", "months"), YEARLY("year", "years")
}

enum class Weekday(val full: String) {
    MO("Monday"), TU("Tuesday"), WE("Wednesday"), TH("Thursday"), FR("Friday"), SA("Saturday"), SU("Sunday");

    val short get() = full.substring(0, 3)
}

data class ByDay(/** 0 = every such day */ val ord: Int, val day: Weekday)

data class RepeatRule(
    val freq: Freq = Freq.WEEKLY,
    val interval: Int = 1,
    val byday: List<ByDay> = emptyList(),
    val bymonthday: List<Int> = emptyList(),
    val bymonth: List<Int> = emptyList(),
    val bysetpos: List<Int> = emptyList(),
    val count: Int? = null,
    /** `YYYY-MM-DD` */
    val until: String? = null,
    /** Repeat relative to when the task was completed. */
    val fromCompletion: Boolean = false,
    /** Parts we don't edit, kept as written. */
    val extra: List<String> = emptyList(),
)

val MONTH_NAMES = listOf("January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December")
private val ORDINALS = mapOf(1 to "first", 2 to "second", 3 to "third", 4 to "fourth", 5 to "fifth", -1 to "last", -2 to "second to last")
private val WORKDAYS = listOf(Weekday.MO, Weekday.TU, Weekday.WE, Weekday.TH, Weekday.FR)
private val BYDAY = Regex("""^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$""")
private val UNTIL = Regex("""^(\d{4})(\d{2})(\d{2})""")

private fun ints(v: String) = v.split(",").mapNotNull { it.trim().toIntOrNull() }

fun parseRule(input: String?): RepeatRule? {
    if (input.isNullOrBlank()) return null
    var r = RepeatRule(freq = Freq.DAILY)
    var freq: Freq? = null
    for (part in input.replace(Regex("^RRULE:", RegexOption.IGNORE_CASE), "").split(";")) {
        val k = part.substringBefore("=").trim().uppercase()
        val v = part.substringAfter("=", "").trim().uppercase()
        if (k.isEmpty()) continue
        when (k) {
            "FREQ" -> freq = Freq.entries.firstOrNull { it.name == v } ?: return null
            "INTERVAL" -> r = r.copy(interval = maxOf(1, v.toIntOrNull() ?: 1))
            "COUNT" -> r = r.copy(count = v.toIntOrNull()?.takeIf { it > 0 })
            "UNTIL" -> r = r.copy(until = UNTIL.find(v)?.let { "${it.groupValues[1]}-${it.groupValues[2]}-${it.groupValues[3]}" })
            "BYDAY" -> {
                val days = v.split(",").map { d ->
                    val m = BYDAY.find(d.trim()) ?: return null
                    ByDay(m.groupValues[1].ifEmpty { "0" }.toInt(), Weekday.valueOf(m.groupValues[2]))
                }
                r = r.copy(byday = r.byday + days)
            }
            "BYMONTHDAY" -> r = r.copy(bymonthday = ints(v))
            "BYMONTH" -> r = r.copy(bymonth = ints(v))
            "BYSETPOS" -> r = r.copy(bysetpos = ints(v))
            "FROM" -> r = if (v == "COMPLETION") r.copy(fromCompletion = true) else r.copy(extra = r.extra + part.trim())
            else -> r = r.copy(extra = r.extra + part.trim())
        }
    }
    return r.copy(freq = freq ?: return null)
}

fun buildRule(r: RepeatRule): String {
    val parts = mutableListOf("FREQ=${r.freq.name}")
    if (r.interval > 1) parts += "INTERVAL=${r.interval}"
    if (r.bymonth.isNotEmpty()) parts += "BYMONTH=${r.bymonth.joinToString(",")}"
    if (r.byday.isNotEmpty()) parts += "BYDAY=" + r.byday.joinToString(",") { "${if (it.ord == 0) "" else it.ord}${it.day.name}" }
    if (r.bymonthday.isNotEmpty()) parts += "BYMONTHDAY=${r.bymonthday.joinToString(",")}"
    if (r.bysetpos.isNotEmpty()) parts += "BYSETPOS=${r.bysetpos.joinToString(",")}"
    if (r.count != null && r.count > 0) parts += "COUNT=${r.count}"
    else if (r.until != null) parts += "UNTIL=${r.until.replace("-", "")}"
    parts += r.extra
    if (r.fromCompletion) parts += "FROM=COMPLETION"
    return parts.joinToString(";")
}

private fun suffix(n: Int): String = if (n % 100 in 11..13) "th" else when (n % 10) {
    1 -> "st"
    2 -> "nd"
    3 -> "rd"
    else -> "th"
}

fun ordinalDay(n: Int): String = when {
    n == -1 -> "last day"
    n < 0 -> "${-n}${suffix(-n)} to last day"
    else -> "$n${suffix(n)}"
}

private fun isWorkdays(days: List<Weekday>) = days.size == 5 && days.containsAll(WORKDAYS)

/** The day pattern within a month ("the 15th", "the last Friday"), if any. */
private fun monthPattern(r: RepeatRule): String? {
    val days = r.byday.map { it.day }
    if (r.bysetpos.size == 1 && days.isNotEmpty() && r.byday.all { it.ord == 0 }) {
        val what = when {
            isWorkdays(days) -> "weekday"
            days.size == 1 -> days[0].full
            else -> days.joinToString("/") { it.short }
        }
        return "the ${ORDINALS[r.bysetpos[0]] ?: r.bysetpos[0]} $what"
    }
    if (r.byday.isNotEmpty() && r.byday.all { it.ord != 0 }) {
        return r.byday.joinToString(" and ") { "the ${ORDINALS[it.ord] ?: it.ord} ${it.day.full}" }
    }
    if (r.bymonthday.isNotEmpty() && r.byday.isEmpty()) return "the " + r.bymonthday.joinToString(" and ", transform = ::ordinalDay)
    return null
}

/** "Every 2 weeks on Mon, Thu", "Every month on the last Friday", … */
fun describeRule(input: String?): String? {
    if (input.isNullOrBlank()) return null
    val r = parseRule(input) ?: return "Custom repeat"
    var text = if (r.interval > 1) "Every ${r.interval} ${r.freq.many}" else "Every ${r.freq.one}"
    val days = r.byday.map { it.day }
    when {
        r.freq == Freq.DAILY && r.interval == 1 && isWorkdays(days) -> text = "Every weekday"
        r.freq == Freq.WEEKLY && days.isNotEmpty() ->
            if (r.interval == 1 && isWorkdays(days)) text = "Every weekday" else text += " on " + days.joinToString(", ") { it.short }
        r.freq == Freq.MONTHLY -> monthPattern(r)?.let { text += " on $it" }
        r.freq == Freq.YEARLY -> {
            val months = r.bymonth.mapNotNull { MONTH_NAMES.getOrNull(it - 1) }
            val p = monthPattern(r)
            if (p != null && months.isNotEmpty()) {
                text += if (r.byday.isEmpty() && r.bymonthday.size == 1 && r.bymonthday[0] > 0) " on ${r.bymonthday[0]} ${months.joinToString(", ")}"
                else " on $p of ${months.joinToString(", ")}"
            } else if (months.isNotEmpty()) text += " in ${months.joinToString(", ")}"
        }
    }
    if (r.extra.isNotEmpty()) return "Custom repeat"
    if (r.fromCompletion) text += " after completion"
    if (r.count != null) text += if (r.count == 1) ", once more" else ", ${r.count} times"
    else if (r.until != null) {
        runCatching { LocalDate.parse(r.until) }.getOrNull()?.let {
            text += ", until " + it.format(DateTimeFormatter.ofPattern("d MMM yyyy", Locale.ENGLISH))
        }
    }
    return text
}

/** RRULE weekday for a date. */
fun weekdayOf(d: LocalDate): Weekday = Weekday.entries[d.dayOfWeek.value - 1]

/** Which occurrence of its weekday a date is within its month (1…5), and whether it is the last. */
fun weekOfMonth(d: LocalDate): Pair<Int, Boolean> = ((d.dayOfMonth - 1) / 7 + 1) to (d.dayOfMonth + 7 > d.lengthOfMonth())

private fun matchesDay(r: RepeatRule, d: LocalDate): Boolean {
    if (r.bymonth.isNotEmpty() && d.monthValue !in r.bymonth) return false
    val dim = d.lengthOfMonth()
    if (r.bymonthday.isNotEmpty() && r.bymonthday.none { (if (it > 0) it else dim + 1 + it) == d.dayOfMonth }) return false
    if (r.byday.isNotEmpty()) {
        val wd = weekdayOf(d)
        val nth = (d.dayOfMonth - 1) / 7 + 1
        val fromEnd = (dim - d.dayOfMonth) / 7 + 1
        if (r.byday.none { it.day == wd && (it.ord == 0 || it.ord == nth || it.ord == -fromEnd) }) return false
        if (r.bysetpos.isNotEmpty()) {
            // Only the common "last/first weekday of the month" style is checked.
            val month = YearMonth.from(d)
            val same = (1..dim).map { month.atDay(it) }.filter { x -> r.byday.any { it.day == weekdayOf(x) } }
            val idx = same.indexOf(d)
            return r.bysetpos.any { (if (it > 0) it - 1 else same.size + it) == idx }
        }
    }
    return true
}

/**
 * The first day on or after [from] that matches a rule's day pattern, used to
 * give "every last Friday" a sensible first due date.
 */
fun firstOccurrence(input: String, from: LocalDate): LocalDate {
    val r = parseRule(input) ?: return from
    if (r.byday.isEmpty() && r.bymonthday.isEmpty()) return from
    for (i in 0L until 400L) {
        val d = from.plusDays(i)
        if (matchesDay(r, d)) return d
    }
    return from
}

class RepeatOption(val id: String, val label: String, val rrule: String?)

val REPEAT_OPTIONS = listOf(
    RepeatOption("none", "Does not repeat", null),
    RepeatOption("daily", "Every day", "FREQ=DAILY"),
    RepeatOption("weekdays", "Every weekday", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"),
    RepeatOption("weekly", "Every week", "FREQ=WEEKLY"),
    RepeatOption("biweekly", "Every 2 weeks", "FREQ=WEEKLY;INTERVAL=2"),
    RepeatOption("monthly", "Every month", "FREQ=MONTHLY"),
    RepeatOption("yearly", "Every year", "FREQ=YEARLY"),
)

fun repeatValue(rrule: String?): String {
    if (rrule.isNullOrBlank()) return "none"
    val norm = rrule.uppercase().removePrefix("RRULE:")
    return REPEAT_OPTIONS.firstOrNull { it.rrule == norm }?.id ?: "custom"
}

fun repeatLabel(rrule: String?): String? {
    if (rrule.isNullOrBlank()) return null
    val v = repeatValue(rrule)
    return if (v == "custom") describeRule(rrule) else REPEAT_OPTIONS.first { it.id == v }.label
}
