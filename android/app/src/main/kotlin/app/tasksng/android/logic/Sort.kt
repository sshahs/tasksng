package app.tasksng.android.logic

import app.tasksng.android.core.Task
import app.tasksng.android.core.TaskPatch
import java.time.Instant
import java.time.ZoneId

enum class SortMode(val id: String, val label: String, val listsOnly: Boolean = false) {
    Smart("smart", "Due date, then priority"),
    Manual("manual", "Manual (drag to reorder)", listsOnly = true),
    Priority("priority", "Priority"),
    Title("title", "Title"),
    Created("created", "Newest first");

    companion object {
        fun of(id: String?) = entries.firstOrNull { it.id == id } ?: Smart
    }
}

/** Seconds between 1970 and 2001, the epoch Apple uses for X-APPLE-SORT-ORDER. */
private const val APPLE_EPOCH = 978_307_200L
const val ORDER_STEP = 1024L

private fun dueKey(t: Task, zone: ZoneId): Long = instantOf(t.due, zone)?.toEpochMilli() ?: Long.MAX_VALUE
private fun prioKey(t: Task) = if (t.priority == 0) 10 else t.priority
private fun createdMs(t: Task): Long = t.created?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() } ?: 0L

/**
 * Position in manual order. Tasks without an explicit order sort by creation
 * time, which is what Apple Reminders writes for new items.
 */
fun manualKey(t: Task): Long = t.sortOrder ?: if (t.created != null) createdMs(t) / 1000 - APPLE_EPOCH else 0L

private val byTitle = Comparator<Task> { a, b -> naturalCompare(a.summary, b.summary) }

/** Compares text ignoring case, with numbers in it by value ("Task 2" before "Task 10"). */
fun naturalCompare(a: String, b: String): Int {
    var i = 0
    var j = 0
    while (i < a.length && j < b.length) {
        val ca = a[i]
        val cb = b[j]
        if (ca.isDigit() && cb.isDigit()) {
            var ei = i
            while (ei < a.length && a[ei].isDigit()) ei++
            var ej = j
            while (ej < b.length && b[ej].isDigit()) ej++
            val na = a.substring(i, ei).trimStart('0')
            val nb = b.substring(j, ej).trimStart('0')
            if (na.length != nb.length) return na.length - nb.length
            val c = na.compareTo(nb)
            if (c != 0) return c
            i = ei
            j = ej
        } else {
            val c = ca.lowercaseChar().compareTo(cb.lowercaseChar())
            if (c != 0) return c
            i++
            j++
        }
    }
    return (a.length - i) - (b.length - j)
}

fun compareOpen(zone: ZoneId = ZoneId.systemDefault()): Comparator<Task> =
    compareBy<Task> { dueKey(it, zone) }
        .thenBy { prioKey(it) }
        .thenBy { it.sortOrder ?: 0L }
        .thenBy { it.created ?: "" }
        .thenBy { it.summary }

val compareDone: Comparator<Task> = compareByDescending<Task> { it.completedAt ?: "" }.thenBy { it.summary }

fun comparator(mode: SortMode, zone: ZoneId = ZoneId.systemDefault()): Comparator<Task> = when (mode) {
    SortMode.Manual -> compareBy<Task> { manualKey(it) }.thenBy { createdMs(it) }.then(byTitle)
    SortMode.Priority -> compareBy<Task> { prioKey(it) }.then(compareOpen(zone))
    SortMode.Title -> byTitle.then(compareOpen(zone))
    SortMode.Created -> compareByDescending<Task> { createdMs(it) }.then(byTitle)
    SortMode.Smart -> compareOpen(zone)
}

/**
 * Edits needed to put [moving] at [index] among [siblings] (shown in this
 * order, without [moving]) under [parentUid]. Uses a single write when there
 * is room between the neighbours, otherwise renumbers the group.
 */
fun planReorder(siblings: List<Task>, moving: Task, index: Int, parentUid: String?): List<Pair<String, TaskPatch>> {
    val others = siblings.filter { it.id != moving.id }
    val at = index.coerceIn(0, others.size)
    val seq = others.subList(0, at) + moving + others.subList(at, others.size)
    val parentChanged = moving.parentUid != parentUid
    val keys = others.map(::manualKey)
    val increasing = keys.zipWithNext().all { (a, b) -> b > a }
    val prev = keys.getOrNull(at - 1)
    val next = keys.getOrNull(at)

    var order: Long? = null
    if (increasing) {
        order = when {
            prev == null && next == null -> manualKey(moving)
            prev == null -> next!! - ORDER_STEP
            next == null -> prev + ORDER_STEP
            next - prev >= 2 -> Math.floorDiv(prev + next, 2)
            else -> null
        }
    }
    if (order != null) {
        var patch = TaskPatch()
        if (order != moving.sortOrder) patch = patch.sortOrder(order)
        if (parentChanged) patch = patch.parentUid(parentUid)
        return if (patch.isEmpty) emptyList() else listOf(moving.id to patch)
    }
    // No room (or the list was sorted differently until now): renumber.
    val base = minOf(seq.minOf(::manualKey), 0L)
    return seq.mapIndexedNotNull { i, t ->
        val sortOrder = base + (i + 1) * ORDER_STEP
        var patch = TaskPatch()
        if (t.sortOrder != sortOrder) patch = patch.sortOrder(sortOrder)
        if (t.id == moving.id && parentChanged) patch = patch.parentUid(parentUid)
        if (patch.isEmpty) null else t.id to patch
    }
}
