package app.tasksng.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.automirrored.filled.Notes
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Flag
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.NotificationsNone
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Repeat
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Snooze
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.outlined.Event
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.tasksng.android.core.Task
import app.tasksng.android.core.TaskPatch
import app.tasksng.android.core.TaskStatus
import app.tasksng.android.logic.Row as TaskRowData
import app.tasksng.android.logic.DEFAULT_MINUTES
import app.tasksng.android.logic.comparator
import app.tasksng.android.logic.SortMode
import app.tasksng.android.logic.formatDue
import app.tasksng.android.logic.formatMinutes
import app.tasksng.android.logic.formatTimestamp
import app.tasksng.android.logic.iso
import app.tasksng.android.logic.isSnoozed
import app.tasksng.android.logic.parseDue
import app.tasksng.android.logic.reminderLabel
import app.tasksng.android.logic.repeatLabel
import app.tasksng.android.logic.snoozeLabel
import app.tasksng.android.logic.statusLabel
import app.tasksng.android.logic.toggleChecklistLine
import kotlinx.coroutines.delay
import java.time.ZonedDateTime

private sealed interface DetailSheet {
    data object Due : DetailSheet
    data object Start : DetailSheet
    data object Repeat : DetailSheet
    data object Reminders : DetailSheet
    data object Tags : DetailSheet
    data object Move : DetailSheet
    data object Plan : DetailSheet
    data object Snooze : DetailSheet
    data object History : DetailSheet
    data object Parent : DetailSheet
    data class SubMenu(val id: String) : DetailSheet
}

@Composable
private fun FieldRow(icon: ImageVector, label: String, value: String?, valueColor: Color = MaterialTheme.colorScheme.onSurface, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 13.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.width(16.dp))
        if (value == null) Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyLarge)
        else Column {
            Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(value, style = MaterialTheme.typography.bodyLarge, color = valueColor)
        }
    }
}

/**
 * A text field that keeps what is typed and saves it a moment after typing
 * stops, when it loses focus and when the screen is left.
 */
@Composable
private fun rememberDraft(key: String, value: String, save: (String) -> Unit): Pair<String, (String) -> Unit> {
    var draft by remember(key) { mutableStateOf(value) }
    var dirty by remember(key) { mutableStateOf(false) }
    val latestSave by rememberUpdatedState(save)
    // A change from elsewhere (a sync, an undo) shows unless something is being typed.
    LaunchedEffect(value) { if (!dirty) draft = value }
    LaunchedEffect(draft, dirty) {
        if (!dirty) return@LaunchedEffect
        delay(700)
        latestSave(draft)
        dirty = false
    }
    DisposableEffect(key) {
        onDispose { if (dirty) latestSave(draft) }
    }
    return draft to { v: String ->
        draft = v
        dirty = true
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun TaskDetailScreen(vm: TasksViewModel, taskId: String, onClose: () -> Unit) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val prefs by vm.prefs.collectAsStateWithLifecycle()
    val t = snapshot.tasks.firstOrNull { it.id == taskId } ?: return
    val list = snapshot.lists.firstOrNull { it.id == t.listId }
    val readOnly = list?.readOnly == true
    val now = remember(t) { ZonedDateTime.now() }
    var sheet by remember { mutableStateOf<DetailSheet?>(null) }
    var menu by remember { mutableStateOf(false) }
    var editNotes by remember(taskId) { mutableStateOf(!prefs.notesPreview || t.description.isBlank()) }
    var newSub by remember(taskId) { mutableStateOf("") }
    val (title, setTitle) = rememberDraft("title:$taskId", t.summary) { if (it.trim() != t.summary && it.isNotBlank()) vm.update(taskId, TaskPatch().summary(it.trim())) }
    val (notes, setNotes) = rememberDraft("notes:$taskId", t.description) { if (it != t.description) vm.update(taskId, TaskPatch().description(it)) }
    val subtasks = remember(snapshot.tasks, t.uid) {
        snapshot.tasks.filter { it.parentUid == t.uid && it.listId == t.listId }.sortedWith(compareBy<Task> { it.completed }.then(comparator(SortMode.Manual)))
    }
    val parent = t.parentUid?.let { p -> snapshot.tasks.firstOrNull { it.uid == p && it.listId == t.listId } }
    val allTags = remember(snapshot.tasks) { snapshot.tasks.flatMap { it.categories }.distinctBy { it.lowercase() }.sortedBy { it.lowercase() } }

    BackHandler(onBack = onClose)
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(list?.name.orEmpty(), style = MaterialTheme.typography.titleMedium) },
                navigationIcon = { IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                actions = {
                    if (!t.completed) IconButton(onClick = { sheet = DetailSheet.Snooze }) { Icon(Icons.Default.Snooze, "Snooze") }
                    Box {
                        IconButton(onClick = { menu = true }) { Icon(Icons.Default.MoreVert, "More") }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            val items: List<Pair<String, () -> Unit>> = listOf(
                                "Duplicate" to { vm.duplicate(taskId) },
                                "Move to another list…" to { sheet = DetailSheet.Move },
                                (if (t.parentUid != null) "Subtask · change…" else "Make it a subtask of…") to { sheet = DetailSheet.Parent },
                                "History…" to { sheet = DetailSheet.History },
                            )
                            for ((label, action) in items) DropdownMenuItem(text = { Text(label) }, onClick = {
                                menu = false
                                action()
                            })
                            DropdownMenuItem(text = { Text("Delete", color = MaterialTheme.colorScheme.error) }, onClick = {
                                menu = false
                                vm.deleteWithSubtasks(taskId)
                            })
                        }
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).imePadding().verticalScroll(rememberScrollState())) {
            if (parent != null) Text(
                "Subtask of ${parent.summary.ifEmpty { "another task" }}",
                Modifier.clickable { vm.detailId.value = parent.id }.padding(horizontal = 16.dp, vertical = 4.dp),
                style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary,
            )
            Row(verticalAlignment = Alignment.Top, modifier = Modifier.padding(start = 4.dp, end = 8.dp)) {
                TaskCheck(t, { vm.toggleComplete(taskId) }, Modifier.padding(top = 6.dp))
                TextField(
                    value = title,
                    onValueChange = setTitle,
                    modifier = Modifier.weight(1f),
                    readOnly = readOnly,
                    placeholder = { Text("Title") },
                    textStyle = MaterialTheme.typography.titleLarge.copy(textDecoration = if (t.completed) TextDecoration.LineThrough else null),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Done),
                    colors = TextFieldDefaults.colors(
                        focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent,
                        focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent,
                    ),
                )
            }
            if (!t.completed && isSnoozed(t, now)) Surface(color = MaterialTheme.colorScheme.tertiaryContainer, shape = MaterialTheme.shapes.medium, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
                Row(Modifier.fillMaxWidth().padding(start = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Default.Snooze, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(10.dp))
                    Text("Snoozed ${snoozeLabel(t.snoozedUntil!!, now)}", Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                    TextButton(onClick = { vm.snooze(taskId, null) }) { Text("Bring back now") }
                }
            }
            FlowRow(Modifier.padding(horizontal = 16.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (s in TaskStatus.entries) FilterChip(
                    selected = t.status == s, onClick = { if (t.status != s) vm.update(taskId, TaskPatch().status(s)) }, label = { Text(statusLabel(s)) },
                    leadingIcon = if (s == TaskStatus.InProcess) ({ Icon(Icons.Default.PlayArrow, null, Modifier.size(16.dp)) }) else null,
                )
            }
            val due = parseDue(t.due)
            val overdue = !t.completed && due != null && app.tasksng.android.logic.isOverdue(due, now) && !(!due.hasTime && due.day == now.toLocalDate())
            FieldRow(Icons.Outlined.Event, "Due date", due?.let { formatDue(it, now) }, if (overdue) LocalTaskColors.current.overdue else MaterialTheme.colorScheme.onSurface) { sheet = DetailSheet.Due }
            FieldRow(Icons.Default.PlayArrow, "Start date", parseDue(t.start)?.let { formatDue(it, now) }) { sheet = DetailSheet.Start }
            FieldRow(Icons.Default.Repeat, "Repeat", repeatLabel(t.rrule)) { sheet = DetailSheet.Repeat }
            FieldRow(
                Icons.Default.NotificationsNone, "Reminders",
                t.reminders.takeIf { it.isNotEmpty() }?.joinToString(", ") { reminderLabel(it, t, now) },
            ) { sheet = DetailSheet.Reminders }
            FieldRow(
                Icons.Default.Schedule, "Plan a time",
                parseDue(t.planned)?.let { "${formatDue(it, now)} for ${formatMinutes(t.plannedMinutes ?: DEFAULT_MINUTES)}" },
            ) { sheet = DetailSheet.Plan }
            FieldRow(Icons.Default.Tag, "Tags", t.categories.takeIf { it.isNotEmpty() }?.joinToString(" ") { "#$it" }) { sheet = DetailSheet.Tags }
            FieldRow(Icons.AutoMirrored.Filled.List, "List", list?.name) { sheet = DetailSheet.Move }
            Row(Modifier.padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.Flag, null, Modifier.size(20.dp), tint = priorityColor(t.priority) ?: MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.width(16.dp))
                PriorityChips(t.priority) { vm.update(taskId, TaskPatch().priority(it)) }
            }
            HorizontalDivider(Modifier.padding(vertical = 8.dp))

            Row(Modifier.padding(start = 16.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.AutoMirrored.Filled.Notes, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.width(16.dp))
                Text("Notes", Modifier.weight(1f), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (notes.isNotBlank()) IconButton(onClick = {
                    editNotes = !editNotes
                    vm.updatePrefs { it.copy(notesPreview = !editNotes) }
                }) { Icon(if (editNotes) Icons.Default.Visibility else Icons.Default.Edit, if (editNotes) "Show formatted" else "Edit notes") }
            }
            if (editNotes || notes.isBlank()) {
                TextField(
                    value = notes,
                    onValueChange = setNotes,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp),
                    readOnly = readOnly,
                    placeholder = { Text("Add notes. Markdown works: **bold**, lists, - [ ] checklists") },
                    minLines = 3,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                    colors = TextFieldDefaults.colors(
                        focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent,
                        focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent,
                    ),
                )
            } else {
                MarkdownText(notes, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) { line ->
                    vm.update(taskId, TaskPatch().description(toggleChecklistLine(notes, line)))
                }
            }
            HorizontalDivider(Modifier.padding(vertical = 8.dp))

            SectionLabel(if (subtasks.isEmpty()) "Subtasks" else "Subtasks  ${subtasks.count { it.completed }}/${subtasks.size}")
            for (s in subtasks) {
                TaskRow(
                    row = TaskRowData(s, 0, 0, 0, false), listName = null, listColor = null, collapsed = false, now = now,
                    onToggle = { vm.toggleComplete(s.id) }, onOpen = { vm.detailId.value = s.id }, onMenu = { sheet = DetailSheet.SubMenu(s.id) }, onCollapse = null,
                )
            }
            if (!readOnly) Row(Modifier.padding(start = 4.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(44.dp), contentAlignment = Alignment.Center) { Icon(Icons.Default.Add, null, tint = MaterialTheme.colorScheme.onSurfaceVariant) }
                fun add() {
                    if (newSub.isBlank()) return
                    vm.createFromQuickAdd(app.tasksng.android.logic.parseQuickAdd(newSub), t.listId, parentUid = t.uid)
                    newSub = ""
                }
                TextField(
                    value = newSub,
                    onValueChange = { newSub = it },
                    modifier = Modifier.weight(1f).onFocusChanged { if (!it.isFocused) add() },
                    placeholder = { Text("Add a subtask") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done, capitalization = KeyboardCapitalization.Sentences),
                    keyboardActions = KeyboardActions(onDone = { add() }),
                    colors = TextFieldDefaults.colors(
                        focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent,
                        focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent,
                    ),
                )
            }
            Text(
                listOfNotNull(
                    formatTimestamp(t.created)?.let { "Created $it" },
                    formatTimestamp(t.modified)?.let { "Changed $it" },
                    formatTimestamp(t.completedAt)?.takeIf { t.completed }?.let { "Completed $it" },
                    "Not synced yet".takeIf { t.pending },
                ).joinToString(" · "),
                Modifier.padding(16.dp),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(24.dp))
        }
    }

    fun close() {
        sheet = null
    }
    when (val s = sheet) {
        DetailSheet.Due -> DateSheet("Due date", t.due, onDismiss = ::close) { vm.update(taskId, TaskPatch().due(it)) }
        DetailSheet.Start -> DateSheet("Start date", t.start, allowTime = false, onDismiss = ::close) { vm.update(taskId, TaskPatch().start(it)) }
        DetailSheet.Repeat -> RepeatSheet(t.rrule, t.due, ::close) { rule ->
            // A repeating task needs a date to repeat from.
            val patch = TaskPatch().rrule(rule)
            vm.update(taskId, if (rule != null && t.due == null) patch.due(now.toLocalDate().toString()) else patch)
        }
        DetailSheet.Reminders -> ReminderSheet(t, ::close) { vm.update(taskId, TaskPatch().reminders(it)) }
        DetailSheet.Tags -> TagSheet(t.categories, allTags, ::close) { vm.update(taskId, TaskPatch().categories(it)) }
        DetailSheet.Move -> ListPickerSheet("Move to", TasksViewModel.sortedLists(snapshot.lists), t.listId, ::close) { if (it.id != t.listId) vm.move(taskId, it.id) }
        DetailSheet.Plan -> PlanSheet(t, now.plusHours(1).withMinute(0), ::close) { at, minutes -> vm.update(taskId, TaskPatch().planned(at?.let(::iso)).plannedMinutes(minutes)) }
        DetailSheet.Snooze -> SnoozeSheet(t, ::close) { vm.snooze(taskId, it) }
        DetailSheet.History -> HistorySheet(vm, taskId, ::close)
        DetailSheet.Parent -> ParentSheet(vm, t, ::close)
        is DetailSheet.SubMenu -> vm.task(s.id)?.let { sub ->
            TaskMenuSheet(vm, sub, ::close, onSnooze = ::close, onMove = ::close, onParent = { vm.setParent(sub.id, null); close() }, onHistory = ::close)
        } ?: close()
        null -> {}
    }
}
