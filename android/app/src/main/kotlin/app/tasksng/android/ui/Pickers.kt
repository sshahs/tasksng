package app.tasksng.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import app.tasksng.android.core.Reminder
import app.tasksng.android.core.Task
import app.tasksng.android.core.TaskList
import app.tasksng.android.logic.ByDay
import app.tasksng.android.logic.DEFAULT_MINUTES
import app.tasksng.android.logic.Freq
import app.tasksng.android.logic.REPEAT_OPTIONS
import app.tasksng.android.logic.ReminderUnit
import app.tasksng.android.logic.RepeatRule
import app.tasksng.android.logic.Weekday
import app.tasksng.android.logic.buildRule
import app.tasksng.android.logic.describeRule
import app.tasksng.android.logic.formatDayHeading
import app.tasksng.android.logic.formatMinutes
import app.tasksng.android.logic.formatTime
import app.tasksng.android.logic.iso
import app.tasksng.android.logic.nextMonday
import app.tasksng.android.logic.ordinalDay
import app.tasksng.android.logic.parseDue
import app.tasksng.android.logic.parseRule
import app.tasksng.android.logic.relativeReminder
import app.tasksng.android.logic.reminderLabel
import app.tasksng.android.logic.reminderPresets
import app.tasksng.android.logic.repeatValue
import app.tasksng.android.logic.sameReminder
import app.tasksng.android.logic.snoozePresets
import app.tasksng.android.logic.toDue
import app.tasksng.android.logic.weekOfMonth
import app.tasksng.android.logic.weekdayOf
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.ZonedDateTime

/** A bottom sheet with a title; the content scrolls when it is taller than the screen. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun Sheet(title: String?, onDismiss: () -> Unit, content: @Composable () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(bottom = 12.dp)) {
            if (title != null) Text(title, Modifier.padding(horizontal = 20.dp, vertical = 8.dp), style = MaterialTheme.typography.titleMedium)
            content()
        }
    }
}

@Composable
fun SheetItem(
    icon: ImageVector?,
    text: String,
    hint: String? = null,
    selected: Boolean = false,
    destructive: Boolean = false,
    onClick: () -> Unit,
) {
    val color = if (destructive) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 20.dp, vertical = 13.dp), verticalAlignment = Alignment.CenterVertically) {
        if (icon != null) {
            Icon(icon, null, Modifier.size(22.dp), tint = if (destructive) color else MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.width(18.dp))
        }
        Text(text, Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge, color = color)
        if (hint != null) Text(hint, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (selected) {
            Spacer(Modifier.width(8.dp))
            Icon(Icons.Default.Check, "Selected", Modifier.size(20.dp), tint = MaterialTheme.colorScheme.primary)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DayPickerDialog(initial: LocalDate?, onDismiss: () -> Unit, onPick: (LocalDate) -> Unit) {
    val state = rememberDatePickerState(initialSelectedDateMillis = (initial ?: LocalDate.now()).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())
    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(onClick = {
                state.selectedDateMillis?.let { onPick(Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate()) }
                onDismiss()
            }) { Text("OK") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    ) { DatePicker(state) }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TimePickerDialog(initial: LocalTime?, onDismiss: () -> Unit, onPick: (LocalTime) -> Unit) {
    val start = initial ?: LocalTime.of(9, 0)
    val state = rememberTimePickerState(initialHour = start.hour, initialMinute = start.minute, is24Hour = true)
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(onClick = {
                onPick(LocalTime.of(state.hour, state.minute))
                onDismiss()
            }) { Text("OK") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        text = { TimePicker(state) },
    )
}

/**
 * Picks a day and maybe a time. [value] and what [onPick] gets are in the
 * stored form (`YYYY-MM-DD` or a UTC instant); null clears the date.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun DateSheet(title: String, value: String?, allowTime: Boolean = true, onDismiss: () -> Unit, onPick: (String?) -> Unit) {
    val zone = ZoneId.systemDefault()
    val info = remember(value) { parseDue(value, zone) }
    var day by remember { mutableStateOf(info?.day) }
    var time by remember { mutableStateOf(if (info?.hasTime == true) info.date.toLocalTime() else null) }
    var pickDay by remember { mutableStateOf(false) }
    var pickTime by remember { mutableStateOf(false) }
    val today = LocalDate.now(zone)
    Sheet(title, onDismiss) {
        FlowRow(Modifier.padding(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for ((label, d) in listOf("Today" to today, "Tomorrow" to today.plusDays(1), "Next week" to nextMonday(today), "In a week" to today.plusDays(7))) {
                FilterChip(selected = day == d, onClick = { day = d }, label = { Text(label) })
            }
        }
        SheetItem(Icons.Default.Add.takeIf { false }, day?.let { formatDayHeading(it) } ?: "Pick a date", hint = "Change") { pickDay = true }
        if (allowTime) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(time?.let { "At ${formatTime(it)}" } ?: "All day", Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
                if (time != null) TextButton(onClick = { time = null }) { Text("Remove time") }
                TextButton(onClick = { pickTime = true }) { Text(if (time == null) "Add a time" else "Change") }
            }
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (value != null) OutlinedButton(onClick = {
                onPick(null)
                onDismiss()
            }) { Text("Remove") }
            Spacer(Modifier.weight(1f))
            Button(
                enabled = day != null || time != null,
                onClick = {
                    onPick(toDue(day ?: today, time, zone))
                    onDismiss()
                },
            ) { Text("Done") }
        }
    }
    if (pickDay) DayPickerDialog(day, { pickDay = false }) { day = it }
    if (pickTime) TimePickerDialog(time, { pickTime = false }) {
        time = it
        if (day == null) day = today
    }
}

/** Picks a moment (day and time), answered as an instant. */
@Composable
fun MomentPicker(initial: ZonedDateTime, onDismiss: () -> Unit, onPick: (Instant) -> Unit) {
    var day by remember { mutableStateOf<LocalDate?>(null) }
    if (day == null) {
        DayPickerDialog(initial.toLocalDate(), onDismiss) { day = it }
    } else {
        TimePickerDialog(initial.toLocalTime(), onDismiss) { onPick(day!!.atTime(it).atZone(initial.zone).toInstant()) }
    }
}

@Composable
fun SnoozeSheet(task: Task, onDismiss: () -> Unit, onSnooze: (Instant?) -> Unit) {
    val now = remember { ZonedDateTime.now() }
    var custom by remember { mutableStateOf(false) }
    Sheet("Snooze until", onDismiss) {
        for (p in snoozePresets(now)) SheetItem(null, p.label, hint = p.hint) {
            onSnooze(p.at.toInstant())
            onDismiss()
        }
        SheetItem(null, "Pick a day and time…") { custom = true }
        if (task.snoozedUntil != null) {
            HorizontalDivider(Modifier.padding(vertical = 4.dp))
            SheetItem(null, "Bring back now") {
                onSnooze(null)
                onDismiss()
            }
        }
    }
    if (custom) MomentPicker(now.plusDays(1).withHour(9).withMinute(0), { custom = false }) {
        custom = false
        if (it.isAfter(Instant.now())) onSnooze(it)
        onDismiss()
    }
}

@Composable
fun ListPickerSheet(title: String, lists: List<TaskList>, current: String?, onDismiss: () -> Unit, onPick: (TaskList) -> Unit) {
    Sheet(title, onDismiss) {
        for (l in lists.filter { !it.readOnly }) {
            Row(
                Modifier.fillMaxWidth().clickable {
                    onPick(l)
                    onDismiss()
                }.padding(horizontal = 20.dp, vertical = 13.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                ColorDot(parseColor(l.color), 12.dp)
                Spacer(Modifier.width(16.dp))
                Text(l.name, Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
                if (l.id == current) Icon(Icons.Default.Check, "Current", tint = MaterialTheme.colorScheme.primary)
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TagSheet(tags: List<String>, known: List<String>, onDismiss: () -> Unit, onChange: (List<String>) -> Unit) {
    var current by remember { mutableStateOf(tags) }
    var text by remember { mutableStateOf("") }
    fun add(raw: String) {
        val names = raw.split(',', ' ').map { it.trim().removePrefix("#") }.filter { it.isNotEmpty() }
        for (n in names) if (current.none { it.equals(n, ignoreCase = true) }) current = current + n
        text = ""
        onChange(current)
    }
    Sheet("Tags", onDismiss) {
        FlowRow(Modifier.padding(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for (t in current) InputChip(
                selected = true,
                onClick = {
                    current = current - t
                    onChange(current)
                },
                label = { Text("#$t") },
                trailingIcon = { Icon(Icons.Default.Close, "Remove", Modifier.size(16.dp)) },
            )
        }
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp),
            placeholder = { Text("Add a tag") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { if (text.isNotBlank()) add(text) else onDismiss() }),
            trailingIcon = { if (text.isNotBlank()) IconButton(onClick = { add(text) }) { Icon(Icons.Default.Add, "Add") } },
        )
        val suggestions = known.filter { k -> current.none { it.equals(k, ignoreCase = true) } && k.contains(text.trim().removePrefix("#"), ignoreCase = true) }.take(12)
        if (suggestions.isNotEmpty()) {
            FlowRow(Modifier.padding(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (s in suggestions) FilterChip(selected = false, onClick = { add(s) }, label = { Text("#$s") })
            }
        }
    }
}

@Composable
private fun NumberField(value: Int, onChange: (Int) -> Unit, modifier: Modifier = Modifier, range: IntRange = 1..999) {
    var text by remember(value) { mutableStateOf(value.toString()) }
    OutlinedTextField(
        value = text,
        onValueChange = { v ->
            text = v.filter(Char::isDigit).take(3)
            text.toIntOrNull()?.takeIf { it in range }?.let(onChange)
        },
        modifier = modifier.width(84.dp),
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ReminderSheet(task: Task, onDismiss: () -> Unit, onChange: (List<Reminder>) -> Unit) {
    val now = remember { ZonedDateTime.now() }
    var current by remember { mutableStateOf(task.reminders) }
    var custom by remember { mutableStateOf(false) }
    var absolute by remember { mutableStateOf(false) }
    fun toggle(r: Reminder) {
        current = if (current.any { sameReminder(it, r) }) current.filter { !sameReminder(it, r) } else current + r
        onChange(current)
    }
    val anchor = parseDue(task.due ?: task.start)
    Sheet("Reminders", onDismiss) {
        val presets = reminderPresets(task.due, task.start, now)
        for (p in presets) SheetItem(null, p.label, selected = current.any { sameReminder(it, p.reminder) }) { toggle(p.reminder) }
        for (r in current.filter { c -> presets.none { sameReminder(it.reminder, c) } }) {
            SheetItem(null, reminderLabel(r, task, now), selected = true) { toggle(r) }
        }
        HorizontalDivider(Modifier.padding(vertical = 4.dp))
        if (anchor != null) {
            if (!custom) SheetItem(Icons.Default.Add, "Custom…") { custom = true }
            else {
                var amount by remember { mutableStateOf(if (anchor.hasTime) 90 else 2) }
                var unit by remember { mutableStateOf(if (anchor.hasTime) ReminderUnit.Minutes else ReminderUnit.Days) }
                var before by remember { mutableStateOf(true) }
                var related by remember { mutableStateOf("due") }
                var timeOfDay by remember { mutableStateOf(LocalTime.of(9, 0)) }
                var pickTime by remember { mutableStateOf(false) }
                val units = if (anchor.hasTime) ReminderUnit.entries else listOf(ReminderUnit.Days, ReminderUnit.Weeks)
                Column(Modifier.padding(horizontal = 20.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        NumberField(amount, { amount = it }, range = 0..999)
                        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            for (u in units) FilterChip(selected = unit == u, onClick = { unit = u }, label = { Text(u.label) })
                        }
                    }
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        FilterChip(selected = before, onClick = { before = true }, label = { Text("before") })
                        FilterChip(selected = !before, onClick = { before = false }, label = { Text("after") })
                        if (task.due != null && task.start != null) {
                            FilterChip(selected = related == "due", onClick = { related = "due" }, label = { Text("the due date") })
                            FilterChip(selected = related == "start", onClick = { related = "start" }, label = { Text("the start date") })
                        }
                        if (!anchor.hasTime) FilterChip(selected = true, onClick = { pickTime = true }, label = { Text("at ${formatTime(timeOfDay)}") })
                    }
                    Button(onClick = {
                        val r = relativeReminder(amount, unit, before, if (task.due == null) "start" else related, if (anchor.hasTime) null else timeOfDay)
                        if (current.none { sameReminder(it, r) }) {
                            current = current + r
                            onChange(current)
                        }
                        custom = false
                    }) { Text("Add reminder") }
                }
                if (pickTime) TimePickerDialog(timeOfDay, { pickTime = false }) { timeOfDay = it }
            }
        }
        SheetItem(Icons.Default.Add, "At a day and time…") { absolute = true }
    }
    if (absolute) MomentPicker(now.plusHours(1).withMinute(0), { absolute = false }) {
        absolute = false
        val r = Reminder.At(iso(it))
        if (current.none { c -> sameReminder(c, r) }) {
            current = current + r
            onChange(current)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun RepeatSheet(rrule: String?, due: String?, onDismiss: () -> Unit, onChange: (String?) -> Unit) {
    val anchor = remember(due) { parseDue(due)?.day ?: LocalDate.now() }
    var custom by remember { mutableStateOf(repeatValue(rrule) == "custom") }
    var rule by remember { mutableStateOf(parseRule(rrule) ?: RepeatRule(Freq.WEEKLY)) }
    var pickUntil by remember { mutableStateOf(false) }
    val current = repeatValue(rrule)
    Sheet("Repeat", onDismiss) {
        if (!custom) {
            for (o in REPEAT_OPTIONS) SheetItem(null, o.label, selected = current == o.id) {
                onChange(o.rrule)
                onDismiss()
            }
            SheetItem(null, "Custom…", hint = if (current == "custom") describeRule(rrule) else null, selected = current == "custom") { custom = true }
        } else {
            Column(Modifier.padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Every")
                    NumberField(rule.interval, { rule = rule.copy(interval = it) })
                }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (f in Freq.entries) FilterChip(
                        selected = rule.freq == f,
                        onClick = { rule = rule.copy(freq = f, byday = emptyList(), bymonthday = emptyList(), bysetpos = emptyList(), bymonth = emptyList()) },
                        label = { Text(if (rule.interval > 1) f.many else f.one) },
                    )
                }
                if (rule.freq == Freq.WEEKLY) {
                    Text("On", style = MaterialTheme.typography.labelLarge)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        for (d in Weekday.entries) {
                            val on = rule.byday.any { it.day == d }
                            FilterChip(
                                selected = on,
                                onClick = { rule = rule.copy(byday = if (on) rule.byday.filter { it.day != d } else (rule.byday + ByDay(0, d)).sortedBy { it.day.ordinal }) },
                                label = { Text(d.short) },
                            )
                        }
                    }
                }
                if (rule.freq == Freq.MONTHLY) {
                    val (nth, last) = weekOfMonth(anchor)
                    val wd = weekdayOf(anchor)
                    val onDay = rule.byday.isEmpty()
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        FilterChip(selected = onDay && rule.bymonthday.isEmpty(), onClick = { rule = rule.copy(byday = emptyList(), bymonthday = emptyList()) }, label = { Text("On the same day") })
                        FilterChip(
                            selected = rule.bymonthday == listOf(anchor.dayOfMonth),
                            onClick = { rule = rule.copy(byday = emptyList(), bymonthday = listOf(anchor.dayOfMonth)) },
                            label = { Text("On the ${ordinalDay(anchor.dayOfMonth)}") },
                        )
                        FilterChip(
                            selected = rule.byday == listOf(ByDay(nth, wd)),
                            onClick = { rule = rule.copy(byday = listOf(ByDay(nth, wd)), bymonthday = emptyList()) },
                            label = { Text("On the ${listOf("first", "second", "third", "fourth", "fifth")[nth - 1]} ${wd.full}") },
                        )
                        if (last) FilterChip(
                            selected = rule.byday == listOf(ByDay(-1, wd)),
                            onClick = { rule = rule.copy(byday = listOf(ByDay(-1, wd)), bymonthday = emptyList()) },
                            label = { Text("On the last ${wd.full}") },
                        )
                        FilterChip(
                            selected = rule.bymonthday == listOf(-1),
                            onClick = { rule = rule.copy(byday = emptyList(), bymonthday = listOf(-1)) },
                            label = { Text("On the last day") },
                        )
                    }
                }
                Text("Ends", style = MaterialTheme.typography.labelLarge)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.Center) {
                    FilterChip(selected = rule.count == null && rule.until == null, onClick = { rule = rule.copy(count = null, until = null) }, label = { Text("Never") })
                    FilterChip(selected = rule.count != null, onClick = { rule = rule.copy(count = rule.count ?: 10, until = null) }, label = { Text("After a number of times") })
                    FilterChip(selected = rule.until != null, onClick = { pickUntil = true }, label = { Text(rule.until?.let { "On $it" } ?: "On a date") })
                }
                if (rule.count != null) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    NumberField(rule.count ?: 10, { rule = rule.copy(count = it) })
                    Text("times")
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Count from when it's completed")
                        Text("Rather than from the due date", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Switch(checked = rule.fromCompletion, onCheckedChange = { rule = rule.copy(fromCompletion = it) })
                }
                Text(describeRule(buildRule(rule)) ?: "", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { custom = false }) { Text("Back") }
                    Spacer(Modifier.weight(1f))
                    Button(onClick = {
                        onChange(buildRule(rule))
                        onDismiss()
                    }) { Text("Done") }
                }
                Spacer(Modifier.height(4.dp))
            }
        }
    }
    if (pickUntil) DayPickerDialog(rule.until?.let { runCatching { LocalDate.parse(it) }.getOrNull() } ?: anchor.plusMonths(3), { pickUntil = false }) {
        rule = rule.copy(until = it.toString(), count = null)
    }
}

/** Plans a time for a task in the day planner. [suggested] is where it would go when nothing is planned yet. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PlanSheet(task: Task, suggested: ZonedDateTime, onDismiss: () -> Unit, onPlan: (Instant?, Int?) -> Unit) {
    val zone = ZoneId.systemDefault()
    val planned = remember(task.planned) { parseDue(task.planned, zone)?.date?.atZone(zone) }
    var day by remember { mutableStateOf((planned ?: suggested).toLocalDate()) }
    var time by remember { mutableStateOf((planned ?: suggested).toLocalTime().withSecond(0).withNano(0)) }
    var minutes by remember { mutableStateOf(task.plannedMinutes ?: DEFAULT_MINUTES) }
    var pickDay by remember { mutableStateOf(false) }
    var pickTime by remember { mutableStateOf(false) }
    val today = LocalDate.now(zone)
    Sheet("Plan a time", onDismiss) {
        FlowRow(Modifier.padding(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = day == today, onClick = { day = today }, label = { Text("Today") })
            FilterChip(selected = day == today.plusDays(1), onClick = { day = today.plusDays(1) }, label = { Text("Tomorrow") })
            FilterChip(selected = day != today && day != today.plusDays(1), onClick = { pickDay = true }, label = { Text(if (day != today && day != today.plusDays(1)) formatDayHeading(day) else "Another day") })
        }
        SheetItem(null, "Starts at ${formatTime(time)}", hint = "Change") { pickTime = true }
        Text("For", Modifier.padding(horizontal = 20.dp), style = MaterialTheme.typography.labelLarge)
        FlowRow(Modifier.padding(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for (m in listOf(15, 30, 45, 60, 90, 120, 180)) FilterChip(selected = minutes == m, onClick = { minutes = m }, label = { Text(formatMinutes(m)) })
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp)) {
            if (task.planned != null) OutlinedButton(onClick = {
                onPlan(null, null)
                onDismiss()
            }) { Text("Remove plan") }
            Spacer(Modifier.weight(1f))
            Button(onClick = {
                onPlan(day.atTime(time).atZone(zone).toInstant(), minutes)
                onDismiss()
            }) { Text("Plan") }
        }
    }
    if (pickDay) DayPickerDialog(day, { pickDay = false }) { day = it }
    if (pickTime) TimePickerDialog(time, { pickTime = false }) { time = it }
}
