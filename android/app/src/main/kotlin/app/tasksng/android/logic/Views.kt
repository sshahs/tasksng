package app.tasksng.android.logic

import app.tasksng.android.core.Task
import app.tasksng.android.core.TaskList
import kotlinx.serialization.Serializable
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZonedDateTime

/**
 * What the task pane shows: `today`, `plan`, `upcoming`, `important`, `all`,
 * `overview`, or `list:<id>`, `tag:<name>`, `search:<id>`.
 */
typealias ViewId = String

object Views {
    const val TODAY = "today"
    const val PLAN = "plan"
    const val UPCOMING = "upcoming"
    const val IMPORTANT = "important"
    const val ALL = "all"
    const val OVERVIEW = "overview"

    val SMART = listOf(TODAY to "Today", PLAN to "Plan", UPCOMING to "Upcoming", IMPORTANT to "Important", ALL to "All tasks")

    fun list(id: String): ViewId = "list:$id"
    fun tag(name: String): ViewId = "tag:$name"
    fun search(id: String): ViewId = "search:$id"
}

@Serializable
data class SavedSearch(val id: String, val name: String, val query: String)

fun listIdOf(view: ViewId): String? = if (view.startsWith("list:")) view.substring(5) else null
fun tagOf(view: ViewId): String? = if (view.startsWith("tag:")) view.substring(4) else null
fun searchIdOf(view: ViewId): String? = if (view.startsWith("search:")) view.substring(7) else null

data class Row(
    val task: Task,
    val depth: Int,
    /** Number of direct subtasks (and how many are done) for the progress hint. */
    val childCount: Int,
    val childDone: Int,
    val hasVisibleChildren: Boolean,
)

enum class Tone { Normal, Danger, Muted }

data class Section(val id: String, val title: String?, val tone: Tone = Tone.Normal, val rows: List<Row>)

class ViewOptions(
    val search: String = "",
    val showCompleted: Boolean = false,
    val collapsed: Set<String> = emptySet(),
    val sort: SortMode = SortMode.Smart,
    val lists: List<TaskList> = emptyList(),
    val savedSearches: List<SavedSearch> = emptyList(),
    val now: ZonedDateTime = ZonedDateTime.now(),
    /** Just finished: stay where they were for a moment while completed tasks are hidden. */
    val keep: Set<String> = emptySet(),
)

private fun localDay(value: String?, now: ZonedDateTime): LocalDate? = parseDue(value, now.zone)?.day

private fun startsToday(t: Task, now: ZonedDateTime) = localDay(t.start, now) == now.toLocalDate()

/** The saved query behind a view, if it is a tag or saved-search view. */
fun viewQuery(view: ViewId, saved: List<SavedSearch>): Query? {
    tagOf(view)?.let { return parseQuery("tag:\"${it.replace("\"", "")}\"") }
    searchIdOf(view)?.let { id -> return parseQuery(saved.firstOrNull { it.id == id }?.query ?: "") }
    return null
}

private fun completedOn(t: Task, now: ZonedDateTime): Boolean {
    val at = t.completedAt?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: return false
    return LocalDateTime.ofInstant(at, now.zone).toLocalDate() == now.toLocalDate()
}

private fun inView(view: ViewId, t: Task, now: ZonedDateTime, q: Query?, ctx: QueryContext): Boolean {
    listIdOf(view)?.let { return t.listId == it }
    val later = !t.completed && startsLater(t, now)
    if (q != null) return matchesQuery(t, q, ctx)
    return when (view) {
        // The day planner's tray holds today's tasks.
        Views.TODAY, Views.PLAN -> {
            val due = parseDue(t.due, now.zone)
            if (t.completed) completedOn(t, now) else isOverdue(due, now) || isDueToday(due, now) || startsToday(t, now)
        }
        Views.UPCOMING -> t.due != null || later
        Views.IMPORTANT -> t.priority in 1..4 && !later
        Views.ALL -> true
        else -> false
    }
}

private fun key(listId: String, uid: String) = "$listId\u0000$uid"

/** Builds parent → children rows (depth-first) for list views. */
private fun tree(tasks: List<Task>, all: List<Task>, opts: ViewOptions, sort: Comparator<Task>): List<Row> {
    val visible = tasks.mapTo(HashSet()) { it.id }
    val byParent = HashMap<String, MutableList<Task>>()
    val allByParent = HashMap<String, MutableList<Task>>()
    for (t in all) {
        val parent = t.parentUid ?: continue
        val k = key(t.listId, parent)
        allByParent.getOrPut(k) { mutableListOf() }.add(t)
        if (t.id in visible) byParent.getOrPut(k) { mutableListOf() }.add(t)
    }
    val uids = tasks.mapTo(HashSet()) { key(it.listId, it.uid) }
    val roots = tasks.filter { it.parentUid == null || key(it.listId, it.parentUid) !in uids }
    val rows = ArrayList<Row>(tasks.size)
    val seen = HashSet<String>()
    fun walk(t: Task, depth: Int) {
        if (!seen.add(t.id)) return
        val k = key(t.listId, t.uid)
        val kids = (byParent[k] ?: emptyList()).sortedWith(compareBy<Task> { it.completed }.then(sort))
        val allKids = allByParent[k] ?: emptyList()
        rows += Row(t, depth, allKids.size, allKids.count { it.completed }, kids.isNotEmpty())
        if (t.uid !in opts.collapsed) kids.forEach { walk(it, depth + 1) }
    }
    roots.sortedWith(sort).forEach { walk(it, 0) }
    return rows
}

private fun flat(tasks: List<Task>, all: List<Task>): List<Row> {
    if (tasks.isEmpty()) return emptyList()
    val kids = HashMap<String, IntArray>()
    for (k in all) {
        val parent = k.parentUid ?: continue
        val c = kids.getOrPut(key(k.listId, parent)) { IntArray(2) }
        c[0]++
        if (k.completed) c[1]++
    }
    return tasks.map { t ->
        val c = kids[key(t.listId, t.uid)]
        Row(t, 0, c?.get(0) ?: 0, c?.get(1) ?: 0, false)
    }
}

private fun context(lists: List<TaskList>, now: ZonedDateTime) = QueryContext(lists.associate { it.id to it.name }, now)

fun buildSections(view: ViewId, all: List<Task>, opts: ViewOptions): List<Section> {
    val now = opts.now
    val ctx = context(opts.lists, now)
    val q = viewQuery(view, opts.savedSearches)
    val search = if (opts.search.isNotBlank()) parseQuery(opts.search) else null
    val sort = comparator(opts.sort, now.zone)
    val inThisView = all.filter { inView(view, it, now, q, ctx) && (search == null || matchesQuery(it, search, ctx)) }
    // Finished tasks are hidden unless asked for (or the saved search is about them).
    val showDone = opts.showCompleted || q?.wantsDone == true || search?.wantsDone == true
    val keep = if (showDone) emptySet() else opts.keep
    val notDone = inThisView.filter { !it.completed || it.id in keep }
    // Snoozed tasks are out of the way until they come back: in a section of
    // their own in lists, left out of Today, Upcoming and Important.
    val snoozed = notDone.filter { !it.completed && isSnoozed(it, now) }
    val hidden = snoozed.mapTo(HashSet()) { it.id }
    val open = if (hidden.isEmpty()) notDone else notDone.filter { it.id !in hidden }
    fun snoozedSection(): List<Section> =
        if (snoozed.isEmpty()) emptyList()
        else listOf(Section("snoozed", "Snoozed", Tone.Muted, flat(snoozed.sortedWith(compareBy<Task> { it.snoozedUntil ?: "" }.then(sort)), all)))
    val done = if (showDone) inThisView.filter { it.completed } else emptyList()
    val sections = mutableListOf<Section>()
    fun overdueNotToday(t: Task): Boolean {
        val due = parseDue(t.due, now.zone)
        return isOverdue(due, now) && !isDueToday(due, now)
    }

    if (view == Views.TODAY) {
        val (overdue, today) = open.partition(::overdueNotToday)
        if (overdue.isNotEmpty()) sections += Section("overdue", "Overdue", Tone.Danger, flat(overdue.sortedWith(sort), all))
        sections += Section("today", if (overdue.isNotEmpty()) "Today" else null, rows = flat(today.sortedWith(sort), all))
    } else if (view == Views.UPCOMING) {
        fun day(t: Task): LocalDateTime = (parseDue(t.due, now.zone) ?: parseDue(t.start, now.zone))!!.date
        val groups = LinkedHashMap<LocalDate, MutableList<Task>>()
        val overdue = mutableListOf<Task>()
        for (t in open.sortedWith(compareBy<Task> { day(it) }.then(sort))) {
            if (t.due != null && overdueNotToday(t)) overdue += t
            else groups.getOrPut(day(t).toLocalDate()) { mutableListOf() }.add(t)
        }
        if (overdue.isNotEmpty()) sections += Section("overdue", "Overdue", Tone.Danger, flat(overdue, all))
        for ((d, tasks) in groups) sections += Section(d.toString(), formatDayHeading(d, now), rows = flat(tasks.sortedWith(sort), all))
        if (sections.isEmpty()) sections += Section("empty", null, rows = emptyList())
    } else if (listIdOf(view) != null) {
        // Tasks that start later wait in their own section (search finds them anyway).
        val later = if (search != null) emptyList() else open.filter { startsLater(it, now) }
        val laterIds = later.mapTo(HashSet()) { it.id }
        val current = open.filter { it.id !in laterIds }
        // Completed subtasks of open parents stay nested under their parent.
        val parentsOpen = current.mapTo(HashSet()) { key(it.listId, it.uid) }
        val nestedDone = done.filter { it.parentUid != null && key(it.listId, it.parentUid) in parentsOpen }
        val openRows = tree(current + nestedDone, all, opts, sort)
        sections += Section("open", null, rows = openRows)
        if (later.isNotEmpty()) {
            val byStart = compareBy<Task> { instantOf(it.start, now.zone)?.toEpochMilli() ?: 0L }.then(sort)
            sections += Section("later", "Starts later", Tone.Muted, tree(later, all, opts, byStart))
        }
        sections += snoozedSection()
        val shown = openRows.mapTo(HashSet()) { it.task.id }
        val rest = done.filter { it.id !in shown }
        if (rest.isNotEmpty()) sections += Section("done", "Completed", Tone.Muted, tree(rest, all, opts, compareDone))
        return sections
    } else {
        // All tasks, tags and saved searches: tasks that start later go last.
        val later = if (search != null || q?.wantsLater == true) emptyList() else open.filter { startsLater(it, now) }
        val laterIds = later.mapTo(HashSet()) { it.id }
        sections += Section("open", null, rows = flat(open.filter { it.id !in laterIds }.sortedWith(sort), all))
        if (later.isNotEmpty()) sections += Section("later", "Starts later", Tone.Muted, flat(later.sortedWith(sort), all))
        sections += snoozedSection()
    }

    if (done.isNotEmpty()) sections += Section("done", "Completed", Tone.Muted, flat(done.sortedWith(compareDone), all))
    return sections
}

/** Planned for that (local) day in the day planner. */
fun plannedOn(t: Task, day: LocalDate, now: ZonedDateTime): Boolean {
    val at = t.planned?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: return false
    return LocalDateTime.ofInstant(at, now.zone).toLocalDate() == day
}

fun countOpen(view: ViewId, all: List<Task>, now: ZonedDateTime, lists: List<TaskList> = emptyList(), saved: List<SavedSearch> = emptyList()): Int {
    // The planner counts what is planned for today.
    if (view == Views.PLAN) return all.count { !it.completed && !isSnoozed(it, now) && plannedOn(it, now.toLocalDate(), now) }
    val ctx = context(lists, now)
    val q = viewQuery(view, saved)
    return all.count { t ->
        !t.completed && !isSnoozed(t, now) && inView(view, t, now, q, ctx) &&
            // Counts match the main section, without tasks that start later.
            (view == Views.UPCOMING || q?.wantsLater == true || !startsLater(t, now))
    }
}

class TagCount(val tag: String, val count: Int)

/** All tags in use, with the number of current open tasks carrying them. */
fun tagCounts(all: List<Task>, now: ZonedDateTime): List<TagCount> {
    val names = LinkedHashMap<String, String>()
    val counts = HashMap<String, Int>()
    for (t in all) {
        for (c in t.categories) {
            val k = c.lowercase()
            names.putIfAbsent(k, c)
            if (!t.completed && !startsLater(t, now)) counts[k] = (counts[k] ?: 0) + 1
        }
    }
    return names.map { (k, name) -> TagCount(name, counts[k] ?: 0) }.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.tag })
}

/** Whether a task shows up in the given view (used to jump to a task). */
fun isInView(view: ViewId, t: Task, now: ZonedDateTime, lists: List<TaskList> = emptyList(), saved: List<SavedSearch> = emptyList()): Boolean =
    inView(view, t, now, viewQuery(view, saved), context(lists, now))
