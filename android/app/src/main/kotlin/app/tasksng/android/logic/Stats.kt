package app.tasksng.android.logic

import app.tasksng.android.core.Task
import app.tasksng.android.core.TaskList
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZonedDateTime

/** Numbers for the Overview: how things stand and how the last days went. */
data class Overview(
    val open: Int,
    val overdue: Int,
    val dueToday: Int,
    val dueThisWeek: Int,
    val completedToday: Int,
    val completedThisWeek: Int,
    /** Consecutive days (ending today or yesterday) with at least one completed task. */
    val streak: Int,
    /** Completed per day for the last 14 days, oldest first. */
    val perDay: List<Pair<LocalDate, Int>>,
    /** Open tasks per list, largest first. */
    val byList: List<Pair<TaskList, Int>>,
    val snoozed: Int,
    val unplanned: Int,
)

fun completedDay(t: Task, now: ZonedDateTime): LocalDate? =
    t.completedAt?.let { runCatching { LocalDateTime.ofInstant(Instant.parse(it), now.zone).toLocalDate() }.getOrNull() }

fun overview(tasks: List<Task>, lists: List<TaskList>, now: ZonedDateTime): Overview {
    val today = now.toLocalDate()
    val open = tasks.filter { !it.completed }
    val doneDays = HashMap<LocalDate, Int>()
    for (t in tasks) {
        if (!t.completed || t.status == app.tasksng.android.core.TaskStatus.Cancelled) continue
        val d = completedDay(t, now) ?: continue
        doneDays[d] = (doneDays[d] ?: 0) + 1
    }
    var streak = 0
    var day = if ((doneDays[today] ?: 0) > 0) today else today.minusDays(1)
    while ((doneDays[day] ?: 0) > 0) {
        streak++
        day = day.minusDays(1)
    }
    val current = open.filter { !isSnoozed(it, now) && !startsLater(it, now) }
    val perList = current.groupingBy { it.listId }.eachCount()
    return Overview(
        open = current.size,
        overdue = current.count { val d = parseDue(it.due, now.zone); isOverdue(d, now) && !isDueToday(d, now) },
        dueToday = current.count { isDueToday(parseDue(it.due, now.zone), now) },
        dueThisWeek = current.count { parseDue(it.due, now.zone)?.day?.let { d -> !d.isBefore(today) && !d.isAfter(today.plusDays(6)) } == true },
        completedToday = doneDays[today] ?: 0,
        completedThisWeek = (0L..6L).sumOf { doneDays[today.minusDays(it)] ?: 0 },
        streak = streak,
        perDay = (13L downTo 0L).map { today.minusDays(it) }.map { it to (doneDays[it] ?: 0) },
        byList = lists.map { it to (perList[it.id] ?: 0) }.filter { it.second > 0 }.sortedByDescending { it.second },
        snoozed = open.count { isSnoozed(it, now) },
        unplanned = current.count { isInView(Views.TODAY, it, now) && !plannedOn(it, today, now) },
    )
}
