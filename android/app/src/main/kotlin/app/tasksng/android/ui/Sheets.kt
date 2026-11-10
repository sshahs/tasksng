package app.tasksng.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.DriveFileMove
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.PlayCircleOutline
import androidx.compose.material.icons.filled.Repeat
import androidx.compose.material.icons.filled.Snooze
import androidx.compose.material.icons.filled.SubdirectoryArrowRight
import androidx.compose.material.icons.filled.Today
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material.icons.filled.Flag
import androidx.compose.material.icons.outlined.Event
import androidx.compose.material.icons.outlined.TaskAlt
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.tasksng.android.core.Task
import app.tasksng.android.core.TaskList
import app.tasksng.android.core.TaskPatch
import app.tasksng.android.core.TaskStatus
import app.tasksng.android.core.TaskVersion
import app.tasksng.android.logic.SavedSearch
import app.tasksng.android.logic.changesIn
import app.tasksng.android.logic.describeRule
import app.tasksng.android.logic.differingFields
import app.tasksng.android.logic.formatDue
import app.tasksng.android.logic.parseDue
import app.tasksng.android.logic.parseQuickAdd
import app.tasksng.android.logic.priorityLevel
import app.tasksng.android.logic.resolveList
import app.tasksng.android.logic.restorePatch
import app.tasksng.android.logic.sourceLabel
import app.tasksng.android.logic.versionTime
import java.time.LocalDate

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PriorityChips(priority: Int, modifier: Modifier = Modifier, onPick: (Int) -> Unit) {
    val colors = LocalTaskColors.current
    FlowRow(modifier, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        for ((label, value, color) in listOf(
            Triple("None", 0, MaterialTheme.colorScheme.outline), Triple("Low", 9, colors.low), Triple("Medium", 5, colors.medium), Triple("High", 1, colors.high),
        )) {
            FilterChip(
                selected = priorityLevel(priority) == priorityLevel(value),
                onClick = { onPick(value) },
                label = { Text(label) },
                leadingIcon = { Icon(Icons.Default.Flag, null, Modifier.size(16.dp), tint = color) },
            )
        }
    }
}

/** What long-pressing a task offers. */
@Composable
fun TaskMenuSheet(vm: TasksViewModel, t: Task, onDismiss: () -> Unit, onSnooze: () -> Unit, onMove: () -> Unit, onParent: () -> Unit, onHistory: () -> Unit) {
    val today = LocalDate.now()
    fun run(action: () -> Unit) {
        action()
        onDismiss()
    }
    Sheet(t.summary.ifEmpty { "Untitled task" }, onDismiss) {
        SheetItem(Icons.Outlined.TaskAlt, if (t.completed) "Reopen" else "Complete") { run { vm.toggleComplete(t.id) } }
        if (!t.completed) SheetItem(Icons.Default.PlayCircleOutline, if (t.status == TaskStatus.InProcess) "Not in progress any more" else "Mark as in progress") {
            run { vm.update(t.id, TaskPatch().status(if (t.status == TaskStatus.InProcess) TaskStatus.NeedsAction else TaskStatus.InProcess)) }
        }
        SheetItem(Icons.Default.Today, "Due today") { run { vm.update(t.id, TaskPatch().due(today.toString())) } }
        SheetItem(Icons.Outlined.Event, "Due tomorrow") { run { vm.update(t.id, TaskPatch().due(today.plusDays(1).toString())) } }
        if (!t.completed) SheetItem(Icons.Default.Snooze, if (t.snoozedUntil != null) "Snoozed · change…" else "Snooze…", onClick = onSnooze)
        PriorityChips(t.priority, Modifier.padding(horizontal = 20.dp, vertical = 4.dp)) { p -> run { vm.update(t.id, TaskPatch().priority(p)) } }
        HorizontalDivider(Modifier.padding(vertical = 4.dp))
        SheetItem(Icons.AutoMirrored.Filled.DriveFileMove, "Move to another list…", onClick = onMove)
        SheetItem(Icons.Default.SubdirectoryArrowRight, if (t.parentUid != null) "Subtask · change…" else "Make it a subtask of…", onClick = onParent)
        SheetItem(Icons.Default.SubdirectoryArrowRight, "Add a subtask") { run { vm.quickAdd.value = QuickAddRequest(parent = t) } }
        SheetItem(Icons.Default.ContentCopy, "Duplicate") { run { vm.duplicate(t.id) } }
        SheetItem(Icons.Default.History, "History…", onClick = onHistory)
        SheetItem(Icons.Default.Delete, "Delete", destructive = true) { run { vm.deleteWithSubtasks(t.id) } }
    }
}

/** Picks the task another one becomes a subtask of. */
@Composable
fun ParentSheet(vm: TasksViewModel, t: Task, onDismiss: () -> Unit) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    var filter by remember { mutableStateOf("") }
    val candidates = remember(snapshot.tasks, filter) {
        snapshot.tasks.filter { it.listId == t.listId && it.id != t.id && !it.completed && it.parentUid != t.uid && it.summary.contains(filter, ignoreCase = true) }
            .sortedBy { it.summary.lowercase() }.take(60)
    }
    Sheet("Subtask of", onDismiss) {
        if (t.parentUid != null) SheetItem(null, "Not a subtask any more") {
            vm.setParent(t.id, null)
            onDismiss()
        }
        OutlinedTextField(filter, { filter = it }, Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp), placeholder = { Text("Find a task in this list") }, singleLine = true)
        for (c in candidates) SheetItem(null, c.summary.ifEmpty { "Untitled task" }, selected = c.uid == t.parentUid) {
            vm.setParent(t.id, c)
            onDismiss()
        }
        if (candidates.isEmpty()) Text("No other open tasks in this list.", Modifier.padding(20.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
fun HistorySheet(vm: TasksViewModel, taskId: String, onDismiss: () -> Unit) {
    var versions by remember { mutableStateOf<List<TaskVersion>?>(null) }
    var selected by remember { mutableStateOf<Int?>(null) }
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val current = snapshot.tasks.firstOrNull { it.id == taskId }
    LaunchedEffect(taskId, current?.modified) { versions = vm.history(taskId) }
    Sheet("History", onDismiss) {
        val list = versions
        if (list == null) return@Sheet
        if (list.isEmpty() || current == null) {
            Text(
                "No earlier versions yet. TasksNG keeps the last 25 versions of a task from the first change it sees.",
                Modifier.padding(20.dp), color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            return@Sheet
        }
        list.forEachIndexed { i, v ->
            val changed = changesIn(list, i)
            Column(Modifier.fillMaxWidth().clickable { selected = if (selected == i) null else i }.padding(horizontal = 20.dp, vertical = 10.dp)) {
                Row {
                    Text(versionTime(v.at), Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
                    Text(sourceLabel(v.source), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text(
                    if (changed.isEmpty()) (if (i == list.lastIndex) "First version kept" else "No visible change") else changed.joinToString(", ") { it.label },
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (selected == i) {
                    val diff = differingFields(current, v.task)
                    Spacer(Modifier.height(8.dp))
                    if (diff.isEmpty()) Text("This is how the task is now.", style = MaterialTheme.typography.bodyMedium)
                    else {
                        Text("Restoring would change", style = MaterialTheme.typography.labelLarge)
                        for (f in diff) {
                            Text(f.label, Modifier.padding(top = 6.dp), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                            Text("${f.show(current, snapshot.tasks).take(200)}  →  ${f.show(v.task, snapshot.tasks).take(200)}", style = MaterialTheme.typography.bodyMedium)
                        }
                        Spacer(Modifier.height(8.dp))
                        Button(onClick = {
                            restorePatch(current, v.task)?.let { vm.restoreVersion(taskId, it) }
                            onDismiss()
                        }) { Text("Restore this version") }
                    }
                }
            }
            if (i < list.lastIndex) HorizontalDivider(Modifier.padding(horizontal = 20.dp))
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ListDialog(vm: TasksViewModel, list: TaskList?, onDismiss: () -> Unit) {
    var name by remember { mutableStateOf(list?.name.orEmpty()) }
    var color by remember { mutableStateOf(list?.color?.take(7)?.uppercase() ?: LIST_COLORS[0]) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (list == null) "New list" else "Edit list") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(
                    name, { name = it }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                )
                FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    for (c in LIST_COLORS) {
                        Box(
                            Modifier.size(34.dp).clip(CircleShape).clickable { color = c }
                                .border(if (color == c) BorderStroke(3.dp, MaterialTheme.colorScheme.onSurface) else BorderStroke(0.dp, Color.Transparent), CircleShape),
                            contentAlignment = Alignment.Center,
                        ) { ColorDot(parseColor(c), 24.dp) }
                    }
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                Text("Lists are calendars on your server, so other apps see them too.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        },
        confirmButton = {
            TextButton(enabled = name.isNotBlank() && !busy, onClick = {
                busy = true
                val done: (String?) -> Unit = {
                    busy = false
                    if (it == null) onDismiss() else error = it
                }
                if (list == null) vm.createList(name.trim(), color, done) else vm.updateList(list.id, name.trim(), color, done)
            }) { Text(if (list == null) "Create" else "Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
fun SavedSearchDialog(vm: TasksViewModel, search: SavedSearch?, query: String, onDismiss: () -> Unit) {
    var name by remember { mutableStateOf(search?.name.orEmpty()) }
    var q by remember { mutableStateOf(query) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (search == null) "Save this search" else "Edit saved search") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(name, { name = it }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(q, { q = it }, label = { Text("Search") }, singleLine = true, modifier = Modifier.fillMaxWidth(), supportingText = { Text("e.g. #work !1 due:week -is:progress") })
            }
        },
        confirmButton = {
            TextButton(enabled = q.isNotBlank(), onClick = {
                if (search == null) vm.saveSearch(name, q) else vm.updateSavedSearch(search.id, name, q)
                onDismiss()
            }) { Text("Save") }
        },
        dismissButton = {
            Row {
                if (search != null) TextButton(onClick = {
                    vm.deleteSavedSearch(search.id)
                    onDismiss()
                }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
                TextButton(onClick = onDismiss) { Text("Cancel") }
            }
        },
    )
}

@Composable
fun TagDialog(vm: TasksViewModel, tag: String, onDismiss: () -> Unit) {
    var name by remember { mutableStateOf(tag) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Tag #$tag") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(name, { name = it }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Text("Renaming changes the tag on every task that has it.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        },
        confirmButton = {
            TextButton(enabled = name.isNotBlank(), onClick = {
                vm.renameTag(tag, name)
                onDismiss()
            }) { Text("Rename") }
        },
        dismissButton = {
            Row {
                TextButton(onClick = {
                    vm.removeTag(tag)
                    onDismiss()
                }) { Text("Remove from all tasks", color = MaterialTheme.colorScheme.error) }
                TextButton(onClick = onDismiss) { Text("Cancel") }
            }
        },
    )
}

/**
 * The new task box. What is typed is understood as it is typed ("tomorrow
 * 9am !1 #home every week"), and the box stays open to add several tasks.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun QuickAddSheet(vm: TasksViewModel, request: QuickAddRequest, onDismiss: () -> Unit) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val lists = remember(snapshot.lists) { TasksViewModel.sortedLists(snapshot.lists).filter { !it.readOnly } }
    var text by remember(request.id) { mutableStateOf(request.text) }
    var listId by remember(request.id) { mutableStateOf(request.parent?.listId ?: vm.defaultListId()) }
    var pickList by remember { mutableStateOf(false) }
    var added by remember(request.id) { mutableStateOf(0) }
    val focus = remember { FocusRequester() }
    val parsed = remember(text) { parseQuickAdd(text) }
    val shown = remember(parsed) { if (request.parent == null) vm.viewDefaults(parsed) else parsed }
    val named = resolveList(shown.list, lists)
    val target = named ?: lists.firstOrNull { it.id == listId }

    fun submit() {
        if (parsed.summary.isBlank()) return
        vm.createFromQuickAdd(parsed, listId, parentUid = request.parent?.uid, description = request.notes.takeIf { added == 0 })
        if (named == null && request.parent == null) listId?.let { id -> vm.updatePrefs { it.copy(defaultList = id) } }
        text = ""
        added++
    }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), dragHandle = null) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().imePadding().padding(top = 12.dp, bottom = 8.dp)) {
            if (request.parent != null) Text(
                "Subtask of “${request.parent.summary}”", Modifier.padding(horizontal = 20.dp),
                style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary,
            )
            TextField(
                value = text,
                onValueChange = { text = it },
                modifier = Modifier.fillMaxWidth().focusRequester(focus),
                placeholder = { Text(if (added > 0) "Add another" else "New task — try “tomorrow 9am !1 #home”") },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done, capitalization = KeyboardCapitalization.Sentences),
                keyboardActions = KeyboardActions(onDone = { if (text.isBlank()) onDismiss() else submit() }),
                maxLines = 4,
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent,
                    focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent,
                ),
                textStyle = MaterialTheme.typography.titleMedium,
            )
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Row(Modifier.weight(1f).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (request.parent == null) AssistChip(
                        onClick = { pickList = true },
                        label = { Text(target?.name ?: "No list") },
                        leadingIcon = { ColorDot(parseColor(target?.color), 10.dp) },
                    )
                    shown.due?.let { due -> parseDue(due)?.let { AssistChip(onClick = {}, label = { Text(formatDue(it)) }, leadingIcon = { Icon(Icons.Outlined.Event, null, Modifier.size(16.dp)) }) } }
                    shown.start?.let { s -> parseDue(s)?.let { AssistChip(onClick = {}, label = { Text("From ${formatDue(it)}") }) } }
                    shown.priority?.let { p ->
                        AssistChip(onClick = {}, label = { Text(listOf("", "High", "Medium", "Low")[priorityLevel(p)]) }, leadingIcon = { Icon(Icons.Default.Flag, null, Modifier.size(16.dp), tint = priorityColor(p) ?: Color.Unspecified) })
                    }
                    shown.rrule?.let { AssistChip(onClick = {}, label = { Text(describeRule(it) ?: "Repeats") }, leadingIcon = { Icon(Icons.Default.Repeat, null, Modifier.size(16.dp)) }) }
                    for (c in shown.categories) AssistChip(onClick = {}, label = { Text(c) }, leadingIcon = { Icon(Icons.Default.Tag, null, Modifier.size(16.dp)) })
                }
                Spacer(Modifier.width(8.dp))
                FilledIconButton(onClick = ::submit, enabled = parsed.summary.isNotBlank()) { Icon(Icons.AutoMirrored.Filled.Send, "Add task") }
            }
        }
    }
    LaunchedEffect(request.id) { focus.requestFocus() }
    if (pickList) ListPickerSheet("Add to", lists, target?.id, { pickList = false }) { listId = it.id }
}
