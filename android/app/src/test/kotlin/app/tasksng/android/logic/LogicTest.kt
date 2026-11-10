package app.tasksng.android.logic

import app.tasksng.android.core.ConflictView
import app.tasksng.android.core.Reminder
import app.tasksng.android.core.Task
import app.tasksng.android.core.TaskList
import app.tasksng.android.core.TaskPatch
import app.tasksng.android.core.TaskStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZonedDateTime

private val ZONE: ZoneId = ZoneId.of("Europe/London")

/** Sunday, 4 October 2026, 10:00 local time (BST, UTC+1). */
private val NOW: ZonedDateTime = ZonedDateTime.of(2026, 10, 4, 10, 0, 0, 0, ZONE)

private var n = 0
private fun task(
    summary: String = "Task",
    listId: String = "/l/",
    due: String? = null,
    start: String? = null,
    priority: Int = 0,
    completed: Boolean = false,
    completedAt: String? = null,
    parentUid: String? = null,
    categories: List<String> = emptyList(),
    snoozedUntil: String? = null,
    planned: String? = null,
    plannedMinutes: Int? = null,
    sortOrder: Long? = null,
    created: String? = null,
    rrule: String? = null,
    description: String = "",
    status: TaskStatus = if (completed) TaskStatus.Completed else TaskStatus.NeedsAction,
    modified: String? = null,
    reminders: List<Reminder> = emptyList(),
): Task {
    n++
    return Task(
        id = "$listId$n.ics", uid = "u$n", listId = listId, summary = summary, due = due, start = start, priority = priority,
        completed = completed, completedAt = completedAt, parentUid = parentUid, categories = categories, snoozedUntil = snoozedUntil,
        planned = planned, plannedMinutes = plannedMinutes, sortOrder = sortOrder, created = created, rrule = rrule,
        description = description, status = status, modified = modified, reminders = reminders,
    )
}

private fun opts(search: String = "", showCompleted: Boolean = false, sort: SortMode = SortMode.Smart, lists: List<TaskList> = emptyList(), saved: List<SavedSearch> = emptyList()) =
    ViewOptions(search = search, showCompleted = showCompleted, sort = sort, lists = lists, savedSearches = saved, now = NOW)

class QuickAddTest {
    private fun q(s: String) = parseQuickAdd(s, NOW)

    @Test fun leavesPlainTitlesAlone() {
        assertEquals(QuickAddResult(summary = "Buy milk"), q("Buy milk"))
    }

    @Test fun parsesDatesPriorityAndTags() {
        val r = q("Pay rent tomorrow !1 #home #money")
        assertEquals("Pay rent", r.summary)
        assertEquals("2026-10-05", r.due)
        assertEquals(1, r.priority)
        assertEquals(listOf("home", "money"), r.categories)
    }

    @Test fun parsesWeekdaysAsTheNextOccurrence() {
        assertEquals("2026-10-09", q("Call Bob fri").due)
        assertEquals("2026-10-11", q("Call Bob on sunday").due)
        assertEquals("2026-10-05", q("Plan next week").due)
        assertEquals("2026-10-07", q("Dentist in 3 days").due)
        assertEquals("2026-12-01", q("Report 2026-12-01").due)
        assertEquals("2026-11-01", q("Renew next month").due)
        assertEquals("2026-12-04", q("Check in 2 months").due)
    }

    @Test fun parsesTimes() {
        val r = q("Standup today 9:30")
        assertEquals("Standup", r.summary)
        // 09:30 in London in October is 08:30 UTC.
        assertEquals("2026-10-04T08:30:00Z", r.due)
        val pm = q("Gym at 6pm")
        assertEquals("Gym", pm.summary)
        assertEquals("2026-10-04T17:00:00Z", pm.due)
        assertEquals("2026-10-05T11:00:00Z", q("Lunch tomorrow noon").due)
    }

    @Test fun parsesRepeats() {
        val r = q("Water plants every week")
        assertEquals("Water plants", r.summary)
        assertEquals("FREQ=WEEKLY", r.rrule)
        assertEquals("2026-10-04", r.due)
        assertEquals("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", q("Standup weekdays 9am").rrule)
    }

    @Test fun parsesRicherRepeatsWithAMatchingFirstDueDate() {
        assertEquals("FREQ=DAILY;INTERVAL=3", q("Backup every 3 days").rrule)
        assertEquals("FREQ=WEEKLY;INTERVAL=2", q("Bins every other week").rrule)
        assertEquals("FREQ=WEEKLY;BYDAY=TU,TH", q("Yoga every tue and thu").rrule)
        assertEquals("2026-10-06", q("Yoga every tue and thu").due)
        val lastFri = q("Timesheet every last friday")
        assertEquals("Timesheet", lastFri.summary)
        assertEquals("FREQ=MONTHLY;BYDAY=-1FR", lastFri.rrule)
        assertEquals("2026-10-30", lastFri.due)
        assertEquals("FREQ=MONTHLY;BYMONTHDAY=1", q("Rent every 1st").rrule)
        assertEquals("2026-11-01", q("Rent every 1st").due)
        assertEquals("FREQ=MONTHLY;BYMONTHDAY=15", q("Invoice every month on the 15th").rrule)
        assertEquals("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1", q("Payroll every last weekday").rrule)
        assertEquals("2026-10-30", q("Payroll every last weekday").due)
        val descale = q("Descale every 2 weeks after completion")
        assertEquals("Descale", descale.summary)
        assertEquals("FREQ=WEEKLY;INTERVAL=2;FROM=COMPLETION", descale.rrule)
    }

    @Test fun parsesStartDatesAndLists() {
        val r = q("Tax return starting mon due 2026-10-31 @pers")
        assertEquals("Tax return", r.summary)
        assertEquals("2026-10-05", r.start)
        assertEquals("2026-10-31", r.due)
        assertEquals("pers", r.list)
        assertEquals("2026-10-09", q("Trip from next fri").start)
        val w = q("Water plants every week from monday")
        assertEquals("FREQ=WEEKLY", w.rrule)
        assertEquals("2026-10-05", w.start)
        assertEquals("2026-10-05", w.due)
        assertNull(q("Email bob@example.com").list)
        val s = q("Start the project tomorrow")
        assertEquals("Start the project", s.summary)
        assertNull(s.start)
        assertEquals("2026-10-05", s.due)
    }

    @Test fun doesNotEatWordsInsideOtherWords() {
        assertNull(q("Read today's paper").due)
        assertEquals(emptyList<String>(), q("Fix issue#12").categories)
        assertNull(q("Monday.com setup").due)
    }

    @Test fun keepsTheTextWhenOnlyShortcutsWereTyped() {
        assertEquals("tomorrow", q("tomorrow").summary)
        assertNull(q("tomorrow").due)
    }

    @Test fun findsListsByName() {
        val lists = listOf(TaskList("/a/", "Personal"), TaskList("/b/", "Big project"), TaskList("/c/", "Work"))
        assertEquals("/a/", resolveList("pers", lists)?.id)
        assertEquals("/b/", resolveList("big-project", lists)?.id)
        assertEquals("/b/", resolveList("bigp", lists)?.id)
        assertNull(resolveList("nope", lists))
    }
}

class ViewsTest {
    @Test fun todayShowsOverdueAndDueTodayTasks() {
        val tasks = listOf(task("late", due = "2026-10-01"), task("now", due = "2026-10-04"), task("later", due = "2026-10-05"), task("none"))
        val s = buildSections(Views.TODAY, tasks, opts())
        assertEquals(listOf("Overdue", "Today"), s.map { it.title })
        assertEquals(listOf("late"), s[0].rows.map { it.task.summary })
        assertEquals(listOf("now"), s[1].rows.map { it.task.summary })
        assertEquals(2, countOpen(Views.TODAY, tasks, NOW))
    }

    @Test fun nestsSubtasksInListViewsAndSortsByDueAndPriority() {
        val parent = task("parent", listId = "/a/")
        val tasks = listOf(
            task("b", listId = "/a/", priority = 1), parent, task("child", listId = "/a/", parentUid = parent.uid),
            task("a", listId = "/a/", due = "2026-10-10"), task("other list", listId = "/b/"),
        )
        val rows = buildSections("list:/a/", tasks, opts())[0].rows
        assertEquals(listOf("a" to 0, "b" to 0, "parent" to 0, "child" to 1), rows.map { it.task.summary to it.depth })
        assertEquals(1, rows[2].childCount)
    }

    @Test fun hidesCompletedUnlessAskedKeepingDoneSubtasksUnderOpenParents() {
        val parent = task("p", listId = "/c/")
        val tasks = listOf(
            parent,
            task("done child", listId = "/c/", parentUid = parent.uid, completed = true),
            task("done", listId = "/c/", completed = true, completedAt = "2026-10-03T10:00:00Z"),
        )
        assertEquals(1, buildSections("list:/c/", tasks, opts()).sumOf { it.rows.size })
        val all = buildSections("list:/c/", tasks, opts(showCompleted = true))
        assertEquals(listOf("p", "done child"), all[0].rows.map { it.task.summary })
        assertEquals("Completed", all.last().title)
        assertEquals(listOf("done"), all.last().rows.map { it.task.summary })
    }

    @Test fun upcomingGroupsByDay() {
        val tasks = listOf(task("a", due = "2026-10-06"), task("b", due = "2026-10-05T08:00:00Z"), task("old", due = "2026-09-30"), task("c", due = "2026-10-06"))
        val s = buildSections(Views.UPCOMING, tasks, opts())
        assertEquals(listOf("Overdue", "Tomorrow", "Tuesday"), s.map { it.title })
        assertEquals(listOf("a", "c"), s[2].rows.map { it.task.summary })
    }

    @Test fun snoozedTasksLeaveTodayAndWaitInTheirList() {
        val tasks = listOf(task("z", due = "2026-10-04", snoozedUntil = "2026-10-04T18:00:00Z"), task("now", due = "2026-10-04"))
        assertEquals(listOf("now"), buildSections(Views.TODAY, tasks, opts()).flatMap { it.rows }.map { it.task.summary })
        assertEquals(1, countOpen(Views.TODAY, tasks, NOW))
        val list = buildSections("list:/l/", tasks, opts())
        assertEquals(listOf(null, "Snoozed"), list.map { it.title })
        // A snooze that has ended no longer hides anything.
        val back = listOf(task("z", due = "2026-10-04", snoozedUntil = "2026-10-04T08:00:00Z"))
        assertEquals(1, countOpen(Views.TODAY, back, NOW))
    }

    @Test fun tasksThatStartLaterWaitInTheirOwnSection() {
        val tasks = listOf(task("soon"), task("later", start = "2026-10-10"))
        val s = buildSections("list:/l/", tasks, opts())
        assertEquals(listOf(null, "Starts later"), s.map { it.title })
        assertEquals(1, countOpen("list:/l/", tasks, NOW))
        assertEquals(0, countOpen(Views.IMPORTANT, listOf(task("x", priority = 1, start = "2026-10-10")), NOW))
    }

    @Test fun tagsAndSavedSearchesAreViews() {
        val tasks = listOf(task("a", categories = listOf("Home")), task("b", categories = listOf("work"), priority = 1), task("c"))
        assertEquals(listOf("a"), buildSections("tag:home", tasks, opts()).flatMap { it.rows }.map { it.task.summary })
        val saved = listOf(SavedSearch("s1", "Urgent work", "#work !1"))
        assertEquals(listOf("b"), buildSections("search:s1", tasks, opts(saved = saved)).flatMap { it.rows }.map { it.task.summary })
        assertEquals(1, countOpen("search:s1", tasks, NOW, saved = saved))
        assertEquals(listOf("Home" to 1, "work" to 1), tagCounts(tasks, NOW).map { it.tag to it.count })
    }

    @Test fun planCountsWhatIsPlannedToday() {
        val tasks = listOf(task("p", planned = "2026-10-04T13:00:00Z"), task("t", planned = "2026-10-05T13:00:00Z"), task("n", due = "2026-10-04"))
        assertEquals(1, countOpen(Views.PLAN, tasks, NOW))
    }
}

class SearchTest {
    private val lists = listOf(TaskList("/w/", "Work"), TaskList("/h/", "Big project"))
    private val ctx = QueryContext(lists.associate { it.id to it.name }, NOW)
    private fun find(q: String, tasks: List<Task>) = tasks.filter { matchesQuery(it, parseQuery(q), ctx) }.map { it.summary }

    @Test fun wordsFiltersAndExclusions() {
        val tasks = listOf(
            task("Buy milk", listId = "/h/", categories = listOf("home"), due = "2026-10-04"),
            task("Write report", listId = "/w/", categories = listOf("work"), priority = 1, due = "2026-10-08", status = TaskStatus.InProcess),
            task("Old thing", listId = "/w/", due = "2026-09-01"),
            task("Done thing", listId = "/w/", completed = true),
        )
        assertEquals(listOf("Buy milk"), find("milk", tasks))
        assertEquals(listOf("Buy milk"), find("#home", tasks))
        assertEquals(listOf("Write report"), find("!1", tasks))
        assertEquals(listOf("Write report", "Old thing", "Done thing"), find("list:Work", tasks))
        assertEquals(listOf("Buy milk"), find("list:\"Big project\"", tasks))
        assertEquals(listOf("Buy milk"), find("due:today", tasks))
        assertEquals(listOf("Old thing"), find("due:overdue", tasks))
        assertEquals(listOf("Buy milk", "Write report"), find("due:week", tasks))
        assertEquals(listOf("Done thing"), find("due:none", tasks))
        assertEquals(listOf("Write report"), find("is:progress", tasks))
        assertEquals(listOf("Old thing", "Done thing"), find("list:work -is:progress", tasks))
        assertEquals(listOf("Write report"), find("#work !1 due:week", tasks))
        assertTrue(parseQuery("is:done").wantsDone)
        assertFalse(parseQuery("-is:done").wantsDone)
    }

    @Test fun queriesGiveNewTasksTheirDefaults() {
        val d = parseQuery("#home !2 due:tomorrow list:Work").defaults
        assertEquals(listOf("home"), d.tags)
        assertEquals(5, d.priority)
        assertEquals("tomorrow", d.due)
        assertEquals("Work", d.list)
    }
}

class SortTest {
    @Test fun smartSortsByDueThenPriority() {
        val tasks = listOf(task("none"), task("high", priority = 1), task("due", due = "2026-10-10"), task("sooner", due = "2026-10-05"))
        assertEquals(listOf("sooner", "due", "high", "none"), tasks.sortedWith(comparator(SortMode.Smart, ZONE)).map { it.summary })
        assertEquals(listOf("high", "sooner", "due", "none"), tasks.sortedWith(comparator(SortMode.Priority, ZONE)).map { it.summary })
    }

    @Test fun titlesSortNaturally() {
        val tasks = listOf(task("Task 10"), task("task 2"), task("Apple"))
        assertEquals(listOf("Apple", "task 2", "Task 10"), tasks.sortedWith(comparator(SortMode.Title, ZONE)).map { it.summary })
    }

    @Test fun reorderingUsesOneWriteWhenThereIsRoom() {
        val a = task("a", sortOrder = 1024)
        val b = task("b", sortOrder = 2048)
        val c = task("c", sortOrder = 3072)
        val moves = planReorder(listOf(a, b, c), c, 1, null)
        assertEquals(1, moves.size)
        assertEquals(c.id, moves[0].first)
        assertEquals("""{"sortOrder":1536}""", moves[0].second.toJson().toString())
        // To the front and to the end.
        assertEquals("""{"sortOrder":0}""", planReorder(listOf(a, b, c), c, 0, null)[0].second.toJson().toString())
        assertEquals("""{"sortOrder":4096}""", planReorder(listOf(a, b, c), a, 2, null)[0].second.toJson().toString())
    }

    @Test fun reorderingRenumbersWhenThereIsNoRoom() {
        val a = task("a", sortOrder = 1)
        val b = task("b", sortOrder = 2)
        val c = task("c", sortOrder = 3)
        val moves = planReorder(listOf(a, b, c), c, 1, "parent")
        assertEquals(3, moves.size)
        val moved = moves.first { it.first == c.id }.second.toJson().toString()
        assertEquals("""{"sortOrder":2048,"parentUid":"parent"}""", moved)
    }
}

class RruleTest {
    @Test fun describesRules() {
        assertEquals("Every 2 weeks on Mon, Thu", describeRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH"))
        assertEquals("Every weekday", describeRule("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"))
        assertEquals("Every month on the last Friday", describeRule("FREQ=MONTHLY;BYDAY=-1FR"))
        assertEquals("Every month on the 15th", describeRule("FREQ=MONTHLY;BYMONTHDAY=15"))
        assertEquals("Every month on the last weekday", describeRule("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1"))
        assertEquals("Every year on 25 December", describeRule("FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25"))
        assertEquals("Every 3 days after completion, 5 times", describeRule("FREQ=DAILY;INTERVAL=3;COUNT=5;FROM=COMPLETION"))
        assertEquals("Every week, until 31 Dec 2026", describeRule("FREQ=WEEKLY;UNTIL=20261231T000000Z"))
        assertEquals("Custom repeat", describeRule("FREQ=HOURLY"))
        assertEquals("Custom repeat", describeRule("FREQ=WEEKLY;WKST=SU"))
        assertNull(describeRule(null))
    }

    @Test fun rulesSurviveARoundTrip() {
        for (r in listOf("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH", "FREQ=MONTHLY;BYDAY=-1FR", "FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25", "FREQ=DAILY;COUNT=3;FROM=COMPLETION", "FREQ=WEEKLY;WKST=SU")) {
            assertEquals(r, buildRule(parseRule(r)!!))
        }
        assertEquals("FREQ=WEEKLY;UNTIL=20261231", buildRule(parseRule("FREQ=WEEKLY;UNTIL=20261231T000000Z")!!))
    }

    @Test fun firstOccurrenceFollowsTheDayPattern() {
        val from = LocalDate.of(2026, 10, 4)
        assertEquals(LocalDate.of(2026, 10, 30), firstOccurrence("FREQ=MONTHLY;BYDAY=-1FR", from))
        assertEquals(LocalDate.of(2026, 10, 6), firstOccurrence("FREQ=WEEKLY;BYDAY=TU,TH", from))
        assertEquals(from, firstOccurrence("FREQ=DAILY", from))
        assertEquals("weekdays", repeatValue("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"))
        assertEquals("custom", repeatValue("FREQ=MONTHLY;BYMONTHDAY=3"))
        assertEquals("Every month on the 3rd", repeatLabel("FREQ=MONTHLY;BYMONTHDAY=3"))
    }
}

class PlannerTest {
    private val day = LocalDate.of(2026, 10, 4)

    @Test fun snapsToQuarterHoursInsideTheDay() {
        assertEquals(555, snap(548))
        assertEquals(0, snap(-20))
        assertEquals(24 * 60 - 60, snap(24 * 60, 60))
    }

    @Test fun overlappingBlocksShareTheWidth() {
        val p = layoutSlots(listOf(Slot("a", 540, 600), Slot("b", 570, 630), Slot("c", 700, 730)))
        assertEquals(Placement(0, 2), p["a"])
        assertEquals(Placement(1, 2), p["b"])
        assertEquals(Placement(0, 1), p["c"])
    }

    @Test fun trayHoldsTodaysUnplannedTasks() {
        val tasks = listOf(
            task("late", due = "2026-10-01"), task("today", due = "2026-10-04", priority = 1),
            task("planned", due = "2026-10-04", planned = "2026-10-04T13:00:00Z"), task("tomorrow", due = "2026-10-05"),
            task("snoozed", due = "2026-10-04", snoozedUntil = "2026-10-04T20:00:00Z"),
        )
        assertEquals(listOf("late", "today"), trayTasks(tasks, day, NOW).map { it.summary })
        assertEquals(listOf("tomorrow"), trayTasks(tasks, day.plusDays(1), NOW).map { it.summary })
        assertEquals(listOf("planned"), plannedTasks(tasks, day, NOW).map { it.summary })
    }

    @Test fun addsUpBusyTimeAndFindsFreeSlots() {
        val events = listOf(app.tasksng.android.core.CalEvent("e", start = "2026-10-04T08:00:00Z", end = "2026-10-04T09:00:00Z"))
        val tasks = listOf(task("p", planned = "2026-10-04T08:30:00Z", plannedMinutes = 60))
        // 09:00–10:00 and 09:30–10:30 local overlap: 90 minutes busy.
        assertEquals(90, busyMinutes(day, events, tasks, 0, 24 * 60, ZONE))
        assertEquals(10 * 60 + 30, nextFreeSlot(day, events, tasks, 9 * 60 + 5, 30, ZONE))
        assertEquals("1 h 30 min", formatMinutes(90))
        assertEquals("45 min", formatMinutes(45))
        val (from, to) = dayRange(day, ZONE)
        assertEquals("2026-10-03T23:00:00Z", from)
        assertEquals("2026-10-04T23:00:00Z", to)
    }
}

class RemindersTest {
    @Test fun labelsFitTheDueDate() {
        assertEquals("At due time", reminderLabel(Reminder.Offset(0), "2026-10-04T12:00:00Z", null, NOW))
        assertEquals("15 minutes before", reminderLabel(Reminder.Offset(-900), "2026-10-04T12:00:00Z", null, NOW))
        assertEquals("1 hour 30 minutes before", reminderLabel(Reminder.Offset(-5400), "2026-10-04T12:00:00Z", null, NOW))
        assertEquals("On the day at 09:00", reminderLabel(Reminder.Offset(9 * 3600), "2026-10-06", null, NOW))
        assertEquals("Day before at 09:00", reminderLabel(Reminder.Offset(-15 * 3600), "2026-10-06", null, NOW))
        assertEquals("2 days before at 07:30", reminderLabel(Reminder.Offset(-2 * 86400 + 7 * 3600 + 1800), "2026-10-06", null, NOW))
        assertEquals("Tomorrow 09:00", reminderLabel(Reminder.At("2026-10-05T08:00:00Z"), null, null, NOW))
    }

    @Test fun worksOutWhenTheyGoOff() {
        assertEquals(LocalDateTime.of(2026, 10, 5, 9, 0), reminderTime(Reminder.Offset(-15 * 3600), "2026-10-06", null, NOW))
        assertEquals(LocalDateTime.of(2026, 10, 4, 12, 45), reminderTime(Reminder.Offset(-900), "2026-10-04T12:00:00Z", null, NOW))
        assertEquals(Reminder.Offset(-2 * 86400 + 7 * 3600 + 1800, "due"), relativeReminder(2, ReminderUnit.Days, true, "due", java.time.LocalTime.of(7, 30)))
        assertEquals(Reminder.Offset(-5400, "due"), relativeReminder(90, ReminderUnit.Minutes, true, "due"))
        assertEquals(6, reminderPresets("2026-10-04T12:00:00Z", null, NOW).size)
        assertEquals(4, reminderPresets("2026-10-06", null, NOW).size)
        assertTrue(reminderPresets(null, null, NOW).isNotEmpty())
    }
}

class ConflictsTest {
    @Test fun picksStartFromTheNewerVersionAndMerge() {
        val mine = task("Mine", due = "2026-10-05", priority = 1, modified = "2026-10-04T09:00:00Z")
        val theirs = mine.copy(summary = "Theirs", priority = 5, modified = "2026-10-04T08:00:00Z")
        val c = ConflictView(mine.id, mine.listId, mine, theirs)
        assertEquals(listOf("summary", "priority"), differingFields(mine, theirs).map { it.key })
        assertEquals(mapOf("summary" to true, "priority" to true), defaultPicks(c))
        assertEquals("""{"keep":"mine"}""", resolutionFor(c, defaultPicks(c)).toString())
        assertEquals("""{"keep":"theirs"}""", resolutionFor(c, emptyMap()).toString())
        assertEquals("""{"keep":"merge","patch":{"summary":"Mine"}}""", resolutionFor(c, mapOf("summary" to true, "priority" to false)).toString())
        val deleted = ConflictView(mine.id, mine.listId, null, theirs)
        assertEquals("""{"keep":"mine"}""", resolutionFor(deleted, emptyMap(), keepMineWhole = true).toString())
    }

    @Test fun restoringAVersionPatchesOnlyWhatDiffers() {
        val now = task("New title", due = "2026-10-05", description = "notes")
        val old = now.copy(summary = "Old title", due = null)
        assertEquals("""{"summary":"Old title","due":null}""", restorePatch(now, old)!!.toJson().toString())
        assertNull(restorePatch(now, now.copy(sortOrder = 5)))
        assertEquals("Today 09:30", versionTime("2026-10-04T08:30:00Z", NOW))
        assertEquals("Yesterday 18:00", versionTime("2026-10-03T17:00:00Z", NOW))
    }

    @Test fun patchesShowUpRightAway() {
        val t = task("a", rrule = "FREQ=DAILY")
        val done = TaskPatch().status(TaskStatus.Completed).applyTo(t)
        // A repeating task moves on instead of being completed.
        assertFalse(done.completed)
        assertTrue(done.pending)
        val plain = TaskPatch().status(TaskStatus.Completed).priority(5).due(null).applyTo(task("b", due = "2026-10-05"))
        assertTrue(plain.completed)
        assertEquals(5, plain.priority)
        assertNull(plain.due)
    }
}

class MarkdownTest {
    @Test fun parsesBlocksAndChecklists() {
        val blocks = parseMarkdown("# Title\n\nSome **bold** and _em_ text\nsecond line\n\n- [ ] one\n- [x] two\n  - nested\n\n> quote\n\n```\ncode\n```\n---")
        assertTrue(blocks[0] is Block.Heading)
        assertEquals(2, (blocks[1] as Block.Paragraph).lines.size)
        val list = blocks[2] as Block.ListBlock
        assertEquals(listOf(false, true), list.items.map { it.checked })
        assertEquals(1, list.items[1].sub?.items?.size)
        assertTrue(blocks[3] is Block.Quote)
        assertEquals("code", (blocks[4] as Block.CodeBlock).text)
        assertTrue(blocks[5] is Block.Rule)
    }

    @Test fun onlySafeLinksBecomeLinks() {
        val inline = parseInline("see [docs](https://example.com) and [bad](javascript:alert(1)) www.example.org.")
        val links = inline.filterIsInstance<Inline.Link>().map { it.href }
        assertEquals(listOf("https://example.com", "https://www.example.org"), links)
        assertNull(safeHref("javascript:alert(1)"))
    }

    @Test fun togglesChecklistLines() {
        val src = "- [ ] one\n- [x] two"
        assertEquals("- [x] one\n- [x] two", toggleChecklistLine(src, 0))
        assertEquals("- [ ] one\n- [ ] two", toggleChecklistLine(src, 1))
    }
}

class DatesTest {
    @Test fun formatsDueDates() {
        assertEquals("Today", formatDue(parseDue("2026-10-04", ZONE)!!, NOW))
        assertEquals("Tomorrow 14:30", formatDue(parseDue("2026-10-05T13:30:00Z", ZONE)!!, NOW))
        assertEquals("Friday", formatDue(parseDue("2026-10-09", ZONE)!!, NOW))
        assertEquals("12 Oct", formatDue(parseDue("2026-10-12", ZONE)!!, NOW))
        assertEquals("12 Oct 2027", formatDue(parseDue("2027-10-12", ZONE)!!, NOW))
        assertEquals("Yesterday", formatDue(parseDue("2026-10-03", ZONE)!!, NOW))
        assertNull(parseDue("nonsense", ZONE))
        assertEquals("5 min ago", relativeTime("2026-10-04T08:55:00Z", NOW))
        assertEquals("never", relativeTime(null, NOW))
    }

    @Test fun snoozeChoicesFitTheTimeOfDay() {
        val presets = snoozePresets(NOW)
        // Sunday morning: later today, this evening, tomorrow, next week (no "this weekend").
        assertEquals(listOf("later", "evening", "tomorrow", "week"), presets.map { it.id })
        assertEquals("13:00", presets[0].hint)
        assertEquals("until 18:15", snoozeLabel("2026-10-04T17:15:00Z", NOW))
        assertEquals("until tomorrow 09:00", snoozeLabel("2026-10-05T08:00:00Z", NOW))
        assertEquals(Instant.parse("2026-10-04T17:15:00Z"), nextWake(listOf(task(snoozedUntil = "2026-10-04T17:15:00Z"), task(snoozedUntil = "2026-10-04T07:00:00Z")), NOW))
    }

    @Test fun overviewCountsWhatMatters() {
        val tasks = listOf(
            task("late", due = "2026-10-01"), task("today", due = "2026-10-04"), task("week", due = "2026-10-08"),
            task("d1", completed = true, completedAt = "2026-10-04T08:00:00Z"), task("d2", completed = true, completedAt = "2026-10-03T08:00:00Z"),
            task("d3", completed = true, completedAt = "2026-10-01T08:00:00Z"),
        )
        val o = overview(tasks, listOf(TaskList("/l/", "Inbox")), NOW)
        assertEquals(3, o.open)
        assertEquals(1, o.overdue)
        assertEquals(1, o.dueToday)
        assertEquals(2, o.dueThisWeek)
        assertEquals(1, o.completedToday)
        assertEquals(3, o.completedThisWeek)
        assertEquals(2, o.streak)
        assertEquals(14, o.perDay.size)
        assertEquals(3, o.byList[0].second)
    }
}
