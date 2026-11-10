package app.tasksng.android.logic

import app.tasksng.android.core.ConflictView
import app.tasksng.android.core.Task
import app.tasksng.android.core.TaskPatch
import app.tasksng.android.core.TaskStatus
import app.tasksng.android.core.TaskVersion
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale

/** One field that can differ between two versions of a task. */
class TaskField(
    val key: String,
    val label: String,
    val same: (Task, Task) -> Boolean,
    /** How the field reads (`others`: other tasks, for the parent's title). */
    val show: (Task, List<Task>) -> String,
    /** The patch that gives a task this version's value. */
    val patch: (Task) -> TaskPatch,
)

fun statusLabel(s: TaskStatus) = when (s) {
    TaskStatus.NeedsAction -> "To do"
    TaskStatus.InProcess -> "In progress"
    TaskStatus.Completed -> "Done"
    TaskStatus.Cancelled -> "Cancelled"
}

fun priorityLabel(p: Int) = when (priorityLevel(p)) {
    1 -> "High"
    2 -> "Medium"
    3 -> "Low"
    else -> "None"
}

private fun whenText(value: String?, none: String) = parseDue(value)?.let { formatDue(it) } ?: none

val TASK_FIELDS = listOf(
    TaskField("summary", "Title", { a, b -> a.summary == b.summary }, { t, _ -> t.summary.ifEmpty { "Untitled task" } }, { TaskPatch().summary(it.summary) }),
    TaskField("status", "Status", { a, b -> a.status == b.status }, { t, _ -> statusLabel(t.status) }, { TaskPatch().status(it.status) }),
    TaskField("due", "Due", { a, b -> a.due == b.due }, { t, _ -> whenText(t.due, "No due date") }, { TaskPatch().due(it.due) }),
    TaskField("start", "Start", { a, b -> a.start == b.start }, { t, _ -> whenText(t.start, "No start date") }, { TaskPatch().start(it.start) }),
    TaskField("priority", "Priority", { a, b -> priorityLabel(a.priority) == priorityLabel(b.priority) }, { t, _ -> priorityLabel(t.priority) }, { TaskPatch().priority(it.priority) }),
    TaskField("rrule", "Repeat", { a, b -> (a.rrule ?: "") == (b.rrule ?: "") }, { t, _ -> describeRule(t.rrule) ?: "Does not repeat" }, { TaskPatch().rrule(it.rrule) }),
    TaskField(
        "categories", "Tags", { a, b -> a.categories == b.categories },
        { t, _ -> if (t.categories.isEmpty()) "No tags" else t.categories.joinToString(" ") { "#$it" } },
        { TaskPatch().categories(it.categories) },
    ),
    TaskField(
        "reminders", "Reminders", { a, b -> a.reminders == b.reminders },
        { t, _ -> if (t.reminders.isEmpty()) "No reminders" else t.reminders.joinToString(", ") { reminderLabel(it, t) } },
        { TaskPatch().reminders(it.reminders) },
    ),
    TaskField(
        "planned", "Planned", { a, b -> a.planned == b.planned && (a.plannedMinutes ?: 0) == (b.plannedMinutes ?: 0) },
        { t, _ -> parseDue(t.planned)?.let { "${formatDue(it)} for ${t.plannedMinutes ?: DEFAULT_MINUTES} min" } ?: "Not planned" },
        { TaskPatch().planned(it.planned).plannedMinutes(it.plannedMinutes) },
    ),
    TaskField(
        "snoozedUntil", "Snoozed", { a, b -> (a.snoozedUntil ?: "") == (b.snoozedUntil ?: "") },
        { t, _ -> t.snoozedUntil?.let { "Snoozed ${snoozeLabel(it)}" } ?: "Not snoozed" },
        { TaskPatch().snoozedUntil(it.snoozedUntil) },
    ),
    TaskField(
        "parentUid", "Subtask of", { a, b -> a.parentUid == b.parentUid },
        { t, others -> if (t.parentUid == null) "Not a subtask" else others.firstOrNull { it.uid == t.parentUid }?.summary?.ifEmpty { null } ?: "Another task" },
        { TaskPatch().parentUid(it.parentUid) },
    ),
    TaskField(
        "description", "Notes", { a, b -> a.description.trim() == b.description.trim() },
        { t, _ -> t.description.trim().ifEmpty { "No notes" } },
        { TaskPatch().description(it.description) },
    ),
)

/** The fields the two versions disagree on. */
fun differingFields(mine: Task, theirs: Task): List<TaskField> = TASK_FIELDS.filter { !it.same(mine, theirs) }

/** Starts from the version that was changed last, field by field. `true` = mine. */
fun defaultPicks(c: ConflictView): Map<String, Boolean> {
    val mine = c.mine ?: return emptyMap()
    val theirs = c.theirs ?: return emptyMap()
    val mineNewer = (mine.modified ?: "") >= (theirs.modified ?: "")
    return differingFields(mine, theirs).associate { it.key to mineNewer }
}

/** What to send for the user's picks: one whole side, or theirs with some of ours. */
fun resolutionFor(c: ConflictView, picks: Map<String, Boolean>, keepMineWhole: Boolean = false): JsonObject {
    fun keep(side: String) = buildJsonObject { put("keep", side) }
    val mine = c.mine
    val theirs = c.theirs
    if (mine == null || theirs == null) return keep(if (keepMineWhole) "mine" else "theirs")
    val fields = differingFields(mine, theirs)
    val ours = fields.filter { picks[it.key] == true }
    if (ours.isEmpty()) return keep("theirs")
    if (ours.size == fields.size) return keep("mine")
    val patch = ours.fold(TaskPatch()) { acc, f -> acc + f.patch(mine) }
    return buildJsonObject {
        put("keep", "merge")
        put("patch", patch.toJson())
    }
}

// ---------------------------------------------------------------------------
// History

fun sourceLabel(source: String) = when (source) {
    "created" -> "Created"
    "here" -> "Changed here"
    "elsewhere" -> "Changed on another device"
    else -> "How it was"
}

/** "Today 14:03", "Yesterday 09:12", "Mon 6 Oct 18:30". */
fun versionTime(at: String, now: ZonedDateTime = ZonedDateTime.now()): String {
    val d = runCatching { LocalDateTime.ofInstant(Instant.parse(at), now.zone) }.getOrNull() ?: return ""
    fun f(p: String) = d.format(DateTimeFormatter.ofPattern(p, Locale.ENGLISH))
    val today = now.toLocalDate()
    return when {
        d.toLocalDate() == today -> "Today ${f("HH:mm")}"
        d.toLocalDate() == today.minusDays(1) -> "Yesterday ${f("HH:mm")}"
        d.year == now.year -> f("EEE d MMM HH:mm")
        else -> f("d MMM yyyy HH:mm")
    }
}

/** What a version changed compared with the one before it (versions are newest first). */
fun changesIn(versions: List<TaskVersion>, i: Int): List<TaskField> {
    val older = versions.getOrNull(i + 1) ?: return emptyList()
    return differingFields(older.task, versions[i].task)
}

/** The patch that turns [current] back into [version], or null when they look the same. */
fun restorePatch(current: Task, version: Task): TaskPatch? {
    val fields = differingFields(current, version)
    if (fields.isEmpty()) return null
    return fields.fold(TaskPatch()) { acc, f -> acc + f.patch(version) }
}
