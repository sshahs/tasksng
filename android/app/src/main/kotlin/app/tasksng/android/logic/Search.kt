package app.tasksng.android.logic

import app.tasksng.android.core.Task
import app.tasksng.android.core.TaskStatus
import java.time.LocalDate
import java.time.ZonedDateTime

/**
 * Search and saved-search filters. Words match the title, notes and tags;
 * filters narrow things down, and `-` in front of anything excludes it:
 *
 *   `#home`  `!1` / `!high`  `list:Work` / `list:"Big project"`
 *   `due:today|tomorrow|overdue|week|none|any|2026-10-31`
 *   `is:open|done|progress|cancelled|repeating|reminder|subtask|later`
 */
class QueryContext(val listNames: Map<String, String>, val now: ZonedDateTime)

private typealias Test = (Task, QueryContext) -> Boolean

class Clause(val neg: Boolean, val test: Test)

class QueryDefaults(
    val tags: MutableList<String> = mutableListOf(),
    var priority: Int? = null,
    /** "today" or "tomorrow". */
    var due: String? = null,
    var list: String? = null,
)

class Query(
    val clauses: List<Clause>,
    /** The query asks for finished tasks, so they are not hidden. */
    val wantsDone: Boolean,
    /** The query asks for tasks that start later. */
    val wantsLater: Boolean,
    /** Values new tasks get when added while this query is shown. */
    val defaults: QueryDefaults,
) {
    val empty get() = clauses.isEmpty()
}

val FILTER_HELP = listOf(
    "#home" to "tagged home",
    "!1  !2  !3" to "high, medium, low priority",
    "list:Work" to "in a list",
    "due:today" to "today, tomorrow, overdue, week, none",
    "is:progress" to "open, done, progress, cancelled, repeating, reminder",
    "-#work" to "minus excludes",
)

/** 0 none, 1 high, 2 medium, 3 low. */
fun priorityLevel(p: Int): Int = when {
    p == 0 -> 0
    p <= 4 -> 1
    p == 5 -> 2
    else -> 3
}

private fun levelOf(v: String): Int? = when (v.lowercase()) {
    "1", "high", "!" -> 1
    "2", "med", "medium" -> 2
    "3", "low" -> 3
    "0", "none" -> 0
    else -> null
}

fun startsLater(t: Task, now: ZonedDateTime): Boolean {
    val start = parseDue(t.start, now.zone) ?: return false
    return start.day.isAfter(now.toLocalDate())
}

private val ISO_DAY = Regex("""^\d{4}-\d{2}-\d{2}$""")

private fun dueTest(v: String): Test? {
    fun day(t: Task, c: QueryContext): LocalDate? = parseDue(t.due, c.now.zone)?.day
    return when (v.lowercase()) {
        "today" -> { t, c -> day(t, c) == c.now.toLocalDate() }
        "tomorrow" -> { t, c -> day(t, c) == c.now.toLocalDate().plusDays(1) }
        "overdue" -> { t, c -> !t.completed && isOverdue(parseDue(t.due, c.now.zone), c.now) }
        "week" -> { t, c ->
            val d = day(t, c)
            val today = c.now.toLocalDate()
            d != null && !d.isBefore(today) && !d.isAfter(today.plusDays(6))
        }
        "none" -> { t, _ -> t.due == null }
        "any" -> { t, _ -> t.due != null }
        else -> if (ISO_DAY.matches(v)) {
            val target = runCatching { LocalDate.parse(v) }.getOrNull() ?: return null
            ({ t, c -> day(t, c) == target })
        } else null
    }
}

private fun isTest(v: String): Test? = when (v.lowercase()) {
    "open", "todo" -> { t, _ -> !t.completed }
    "done", "completed" -> { t, _ -> t.status == TaskStatus.Completed }
    "progress", "inprogress", "in-progress", "started" -> { t, _ -> t.status == TaskStatus.InProcess }
    "cancelled", "canceled" -> { t, _ -> t.status == TaskStatus.Cancelled }
    "repeating", "recurring" -> { t, _ -> t.rrule != null }
    "reminder", "reminders" -> { t, _ -> t.reminders.isNotEmpty() }
    "subtask" -> { t, _ -> t.parentUid != null }
    "important" -> { t, _ -> priorityLevel(t.priority) == 1 }
    "later" -> { t, c -> startsLater(t, c.now) }
    "snoozed" -> { t, c -> isSnoozed(t, c.now) }
    "planned" -> { t, _ -> t.planned != null }
    "pending", "unsynced" -> { t, _ -> t.pending }
    else -> null
}

private val TOKEN = Regex("""(-)?(?:([a-z]+):)?(?:"([^"]*)"|(\S+))""", RegexOption.IGNORE_CASE)
private val BANG = Regex("""^!(!!?|[0-3]|high|med|medium|low|none)?$""", RegexOption.IGNORE_CASE)

fun parseQuery(input: String): Query {
    val clauses = mutableListOf<Clause>()
    val defaults = QueryDefaults()
    var wantsDone = false
    var wantsLater = false
    for (m in TOKEN.findAll(input)) {
        val neg = m.groups[1] != null
        val rawKey = m.groups[2]?.value
        val key = rawKey?.lowercase()
        val value = (m.groups[3]?.value ?: m.groups[4]?.value ?: "").trim()
        if (value.isEmpty()) continue
        var test: Test? = null
        if (key == "tag" || (key == null && value.startsWith("#") && value.length > 1)) {
            val name = if (key != null) value else value.substring(1)
            val tag = name.lowercase()
            test = { t, _ -> t.categories.any { it.lowercase() == tag } }
            if (!neg) defaults.tags.add(name)
        } else if (key == null && BANG.matches(value)) {
            val raw = value.substring(1)
            val lvl = when (raw) {
                "!!" -> 1
                "!" -> 2
                "" -> 3
                else -> levelOf(raw)
            }
            if (lvl != null) {
                test = { t, _ -> priorityLevel(t.priority) == lvl }
                if (!neg && lvl > 0) defaults.priority = when (lvl) {
                    1 -> 1
                    2 -> 5
                    else -> 9
                }
            }
        } else if (key == "priority" || key == "p") {
            val lvl = levelOf(value)
            if (lvl != null) test = { t, _ -> priorityLevel(t.priority) == lvl }
        } else if (key == "list" || key == "in") {
            val name = value.lowercase()
            test = { t, c -> (c.listNames[t.listId] ?: "").lowercase().contains(name) }
            if (!neg) defaults.list = value
        } else if (key == "due") {
            test = dueTest(value)
            if (test != null && !neg && (value == "today" || value == "tomorrow")) defaults.due = value
        } else if (key == "is") {
            test = isTest(value)
            val v = value.lowercase()
            if (test != null && !neg && v in setOf("done", "completed", "cancelled", "canceled")) wantsDone = true
            if (test != null && !neg && v == "later") wantsLater = true
        }
        if (test == null) {
            // Plain words (and unknown filters) match the text.
            val word = (if (rawKey != null) "$rawKey:$value" else value).lowercase()
            test = { t, _ ->
                "${t.summary}\n${t.description}\n${t.categories.joinToString(" ") { "#$it" }}".lowercase().contains(word)
            }
        }
        clauses.add(Clause(neg, test))
    }
    return Query(clauses, wantsDone, wantsLater, defaults)
}

fun matchesQuery(t: Task, q: Query, ctx: QueryContext): Boolean = q.clauses.all { it.test(t, ctx) != it.neg }
