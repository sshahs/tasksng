package app.tasksng.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.automirrored.filled.Sort
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.BookmarkAdd
import androidx.compose.material.icons.filled.BookmarkBorder
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.CloudDone
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.DragHandle
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Insights
import androidx.compose.material.icons.filled.Inbox
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material.icons.filled.Today
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.outlined.TaskAlt
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.NavigationDrawerItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.tasksng.android.core.Task
import app.tasksng.android.core.TaskList
import app.tasksng.android.logic.FILTER_HELP
import app.tasksng.android.logic.Row as TaskRowData
import app.tasksng.android.logic.SavedSearch
import app.tasksng.android.logic.Section
import app.tasksng.android.logic.SortMode
import app.tasksng.android.logic.Tone
import app.tasksng.android.logic.Views
import app.tasksng.android.logic.listIdOf
import app.tasksng.android.logic.relativeTime
import app.tasksng.android.logic.searchIdOf
import app.tasksng.android.logic.tagOf
import kotlinx.coroutines.launch
import sh.calvin.reorderable.ReorderableItem
import sh.calvin.reorderable.rememberReorderableLazyListState
import java.time.ZonedDateTime

fun viewIcon(view: String): ImageVector = when (view) {
    Views.TODAY -> Icons.Default.Today
    Views.PLAN -> Icons.Default.Schedule
    Views.UPCOMING -> Icons.Default.CalendarMonth
    Views.IMPORTANT -> Icons.Default.Star
    Views.ALL -> Icons.Default.Inbox
    Views.OVERVIEW -> Icons.Default.Insights
    else -> Icons.AutoMirrored.Filled.List
}

fun viewTitle(view: String, lists: List<TaskList>, saved: List<SavedSearch>): String {
    listIdOf(view)?.let { id -> return lists.firstOrNull { it.id == id }?.name ?: "List" }
    tagOf(view)?.let { return "#$it" }
    searchIdOf(view)?.let { id -> return saved.firstOrNull { it.id == id }?.name ?: "Search" }
    if (view == Views.OVERVIEW) return "Overview"
    return Views.SMART.firstOrNull { it.first == view }?.second ?: "Tasks"
}

/** Dialogs and sheets the main screen can show, one at a time. */
private sealed interface Overlay {
    data class Menu(val id: String) : Overlay
    data class Snooze(val id: String) : Overlay
    data class Move(val id: String) : Overlay
    data class Parent(val id: String) : Overlay
    data class History(val id: String) : Overlay
    data class EditList(val list: TaskList?) : Overlay
    data class DeleteList(val list: TaskList) : Overlay
    data class EditSearch(val search: SavedSearch?, val query: String) : Overlay
    data class EditTag(val tag: String) : Overlay
    data object FilterHelp : Overlay
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainScreen(vm: TasksViewModel) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val prefs by vm.prefs.collectAsStateWithLifecycle()
    val status by vm.status.collectAsStateWithLifecycle()
    val searchOpen by vm.searchOpen.collectAsStateWithLifecycle()
    val search by vm.search.collectAsStateWithLifecycle()
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    var overlay by remember { mutableStateOf<Overlay?>(null) }
    var menuOpen by remember { mutableStateOf(false) }
    var sortOpen by remember { mutableStateOf(false) }
    val lists = remember(snapshot.lists) { TasksViewModel.sortedLists(snapshot.lists) }
    val view = prefs.view
    val listView = listIdOf(view)?.let { id -> lists.firstOrNull { it.id == id } }

    BackHandler(drawer.isOpen) { scope.launch { drawer.close() } }
    BackHandler(searchOpen && !drawer.isOpen) {
        vm.searchOpen.value = false
        vm.search.value = ""
    }
    BackHandler(!searchOpen && !drawer.isOpen && view != Views.TODAY) { vm.setView(Views.TODAY) }

    ModalNavigationDrawer(
        drawerState = drawer,
        drawerContent = {
            Drawer(
                vm, lists,
                onPick = {
                    vm.setView(it)
                    scope.launch { drawer.close() }
                },
                onOverlay = {
                    overlay = it
                    scope.launch { drawer.close() }
                },
                onSettings = {
                    vm.screen.value = Screen.Settings
                    scope.launch { drawer.close() }
                },
            )
        },
    ) {
        Scaffold(
            topBar = {
                if (searchOpen) {
                    SearchBar(search, { vm.search.value = it }, onClose = {
                        vm.searchOpen.value = false
                        vm.search.value = ""
                    }, onSave = { overlay = Overlay.EditSearch(null, search) }, onHelp = { overlay = Overlay.FilterHelp })
                } else TopAppBar(
                    title = {
                        Column {
                            Text(viewTitle(view, lists, prefs.savedSearches), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            if (status.state != "idle" && status.state != "syncing") {
                                Text(
                                    when (status.state) {
                                        "offline" -> if (status.pending > 0) "Offline · ${status.pending} to sync" else "Offline"
                                        "auth-required" -> "Sign in again to sync"
                                        "error" -> "Sync problem"
                                        else -> ""
                                    },
                                    style = MaterialTheme.typography.labelSmall,
                                    color = if (status.state == "offline") MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error,
                                )
                            }
                        }
                    },
                    navigationIcon = { IconButton(onClick = { scope.launch { drawer.open() } }) { Icon(Icons.Default.Menu, "Lists") } },
                    actions = {
                        if (snapshot.conflicts.isNotEmpty()) IconButton(onClick = { vm.screen.value = Screen.Conflicts }) {
                            Icon(Icons.Default.Warning, "Tasks changed on two devices", tint = LocalTaskColors.current.medium)
                        }
                        if (view != Views.PLAN && view != Views.OVERVIEW) IconButton(onClick = { vm.searchOpen.value = true }) { Icon(Icons.Default.Search, "Search") }
                        SyncButton(status.state) { vm.sync(manual = true) }
                        Box {
                            IconButton(onClick = { menuOpen = true }) { Icon(Icons.Default.MoreVert, "More") }
                            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                                if (view != Views.PLAN && view != Views.OVERVIEW) {
                                    DropdownMenuItem(text = { Text("Sort by…") }, leadingIcon = { Icon(Icons.AutoMirrored.Filled.Sort, null) }, onClick = {
                                        menuOpen = false
                                        sortOpen = true
                                    })
                                    DropdownMenuItem(
                                        text = { Text(if (prefs.showCompleted) "Hide completed" else "Show completed") },
                                        leadingIcon = { Icon(Icons.Outlined.TaskAlt, null) },
                                        onClick = {
                                            menuOpen = false
                                            vm.toggleShowCompleted()
                                        },
                                    )
                                }
                                if (listView != null && !listView.readOnly) {
                                    DropdownMenuItem(text = { Text("Edit list…") }, onClick = {
                                        menuOpen = false
                                        overlay = Overlay.EditList(listView)
                                    })
                                    DropdownMenuItem(text = { Text("Delete list…") }, onClick = {
                                        menuOpen = false
                                        overlay = Overlay.DeleteList(listView)
                                    })
                                }
                                tagOf(view)?.let { tag ->
                                    DropdownMenuItem(text = { Text("Rename or remove tag…") }, onClick = {
                                        menuOpen = false
                                        overlay = Overlay.EditTag(tag)
                                    })
                                }
                                searchIdOf(view)?.let { id ->
                                    prefs.savedSearches.firstOrNull { it.id == id }?.let { s ->
                                        DropdownMenuItem(text = { Text("Edit saved search…") }, onClick = {
                                            menuOpen = false
                                            overlay = Overlay.EditSearch(s, s.query)
                                        })
                                    }
                                }
                                DropdownMenuItem(text = { Text("Settings") }, leadingIcon = { Icon(Icons.Default.Settings, null) }, onClick = {
                                    menuOpen = false
                                    vm.screen.value = Screen.Settings
                                })
                            }
                            DropdownMenu(expanded = sortOpen, onDismissRequest = { sortOpen = false }) {
                                val current = vm.sortFor(view)
                                for (mode in SortMode.entries) {
                                    if (mode.listsOnly && listIdOf(view) == null) continue
                                    DropdownMenuItem(
                                        text = { Text(mode.label) },
                                        trailingIcon = { if (mode == current) Icon(Icons.Default.Check, "Selected") },
                                        onClick = {
                                            sortOpen = false
                                            vm.setSort(mode)
                                        },
                                    )
                                }
                            }
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
                )
            },
            floatingActionButton = {
                if (view != Views.OVERVIEW && lists.any { !it.readOnly }) {
                    ExtendedFloatingActionButton(
                        onClick = { vm.quickAdd.value = QuickAddRequest() },
                        icon = { Icon(Icons.Default.Add, null) },
                        text = { Text("New task") },
                    )
                }
            },
        ) { padding ->
            Box(Modifier.fillMaxSize().padding(padding)) {
                when (view) {
                    Views.PLAN -> PlannerScreen(vm)
                    Views.OVERVIEW -> OverviewScreen(vm)
                    else -> TaskListPane(vm, lists, status.state == "syncing") { overlay = it }
                }
            }
        }
    }

    val current = overlay
    fun close() {
        overlay = null
    }
    when (current) {
        is Overlay.Menu -> vm.task(current.id)?.let { t ->
            TaskMenuSheet(
                vm, t, ::close,
                onSnooze = { overlay = Overlay.Snooze(t.id) },
                onMove = { overlay = Overlay.Move(t.id) },
                onParent = { overlay = Overlay.Parent(t.id) },
                onHistory = { overlay = Overlay.History(t.id) },
            )
        } ?: close()
        is Overlay.Snooze -> vm.task(current.id)?.let { t -> SnoozeSheet(t, ::close) { vm.snooze(t.id, it) } } ?: close()
        is Overlay.Move -> vm.task(current.id)?.let { t -> ListPickerSheet("Move to", lists, t.listId, ::close) { vm.move(t.id, it.id) } } ?: close()
        is Overlay.Parent -> vm.task(current.id)?.let { t -> ParentSheet(vm, t, ::close) } ?: close()
        is Overlay.History -> HistorySheet(vm, current.id, ::close)
        is Overlay.EditList -> ListDialog(vm, current.list, ::close)
        is Overlay.DeleteList -> ConfirmDialog(
            "Delete “${current.list.name}”?",
            "The list and all its tasks are deleted on the server too. This can't be undone.",
            "Delete", destructive = true, onDismiss = ::close,
        ) { vm.deleteList(current.list.id) }
        is Overlay.EditSearch -> SavedSearchDialog(vm, current.search, current.query, ::close)
        is Overlay.EditTag -> TagDialog(vm, current.tag, ::close)
        Overlay.FilterHelp -> Sheet("Search filters", ::close) {
            for ((example, meaning) in FILTER_HELP) SettingRow(null, example, meaning)
            Text(
                "Words match the title, notes and tags. Save a search to keep it in the lists drawer.",
                Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        null -> {}
    }
}

@Composable
private fun SyncButton(state: String, onClick: () -> Unit) {
    IconButton(onClick = onClick, enabled = state != "syncing") {
        when (state) {
            "syncing" -> CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            "offline" -> Icon(Icons.Default.CloudOff, "Offline. Sync now", tint = MaterialTheme.colorScheme.onSurfaceVariant)
            "error", "auth-required" -> Icon(Icons.Default.ErrorOutline, "Sync problem. Sync now", tint = MaterialTheme.colorScheme.error)
            else -> Icon(Icons.Default.CloudDone, "Synced. Sync now", tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SearchBar(query: String, onChange: (String) -> Unit, onClose: () -> Unit, onSave: () -> Unit, onHelp: () -> Unit) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    TopAppBar(
        title = {
            TextField(
                value = query,
                onValueChange = onChange,
                modifier = Modifier.fillMaxWidth().focusRequester(focus),
                placeholder = { Text("Search, or #tag !1 due:today") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent,
                    focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent,
                ),
                textStyle = MaterialTheme.typography.bodyLarge,
            )
        },
        navigationIcon = { IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Close search") } },
        actions = {
            if (query.isNotBlank()) {
                IconButton(onClick = onSave) { Icon(Icons.Default.BookmarkAdd, "Save this search") }
                IconButton(onClick = { onChange("") }) { Icon(Icons.Default.Close, "Clear") }
            } else IconButton(onClick = onHelp) { Icon(Icons.Default.BookmarkBorder, "Search filters") }
        },
    )
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun Drawer(vm: TasksViewModel, lists: List<TaskList>, onPick: (String) -> Unit, onOverlay: (Overlay) -> Unit, onSettings: () -> Unit) {
    val prefs by vm.prefs.collectAsStateWithLifecycle()
    val counts by vm.counts.collectAsStateWithLifecycle()
    val status by vm.status.collectAsStateWithLifecycle()
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val padding = Modifier.padding(NavigationDrawerItemDefaults.ItemPadding)

    @Composable
    fun Entry(view: String, label: String, icon: @Composable () -> Unit, onLong: (() -> Unit)? = null, count: Int? = counts.views[view]) {
        NavigationDrawerItem(
            label = { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            selected = prefs.view == view,
            onClick = { onPick(view) },
            icon = icon,
            badge = { if (count != null && count > 0) Text(count.toString(), style = MaterialTheme.typography.labelMedium) },
            modifier = if (onLong != null) padding.combinedClickable(onClick = { onPick(view) }, onLongClick = onLong) else padding,
        )
    }

    ModalDrawerSheet {
        Column(Modifier.verticalScroll(rememberScrollState())) {
            Row(Modifier.padding(start = 28.dp, end = 12.dp, top = 16.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("TasksNG", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                    Text(
                        snapshot.account?.username.orEmpty() + when (status.state) {
                            "syncing" -> " · syncing…"
                            "offline" -> " · offline"
                            else -> " · synced ${relativeTime(status.lastSync ?: snapshot.lastSync)}"
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                IconButton(onClick = onSettings) { Icon(Icons.Default.Settings, "Settings") }
            }
            for ((id, label) in Views.SMART) Entry(id, label, { Icon(viewIcon(id), null) })
            Entry(Views.OVERVIEW, "Overview", { Icon(viewIcon(Views.OVERVIEW), null) }, count = null)
            HorizontalDivider(Modifier.padding(vertical = 8.dp, horizontal = 28.dp))
            SectionLabel("Lists", Modifier.padding(start = 12.dp))
            for (l in lists) Entry(
                Views.list(l.id), l.name, { ColorDot(parseColor(l.color), 12.dp, Modifier.padding(horizontal = 6.dp)) },
                onLong = if (l.readOnly) null else ({ onOverlay(Overlay.EditList(l)) }),
            )
            NavigationDrawerItem(
                label = { Text("New list") }, selected = false, onClick = { onOverlay(Overlay.EditList(null)) },
                icon = { Icon(Icons.Default.Add, null) }, modifier = padding,
            )
            if (prefs.savedSearches.isNotEmpty()) {
                HorizontalDivider(Modifier.padding(vertical = 8.dp, horizontal = 28.dp))
                SectionLabel("Saved searches", Modifier.padding(start = 12.dp))
                for (s in prefs.savedSearches) Entry(Views.search(s.id), s.name, { Icon(Icons.Default.Search, null) }, onLong = { onOverlay(Overlay.EditSearch(s, s.query)) })
            }
            if (counts.tags.isNotEmpty()) {
                HorizontalDivider(Modifier.padding(vertical = 8.dp, horizontal = 28.dp))
                Row(
                    Modifier.fillMaxWidth().clickable { vm.updatePrefs { it.copy(tagsOpen = !it.tagsOpen) } }.padding(end = 24.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    SectionLabel("Tags", Modifier.padding(start = 12.dp).weight(1f))
                    Icon(if (prefs.tagsOpen) Icons.Default.ExpandLess else Icons.Default.ExpandMore, if (prefs.tagsOpen) "Hide tags" else "Show tags", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (prefs.tagsOpen) for (t in counts.tags) Entry(Views.tag(t.tag), t.tag, { Icon(Icons.Default.Tag, null) }, onLong = { onOverlay(Overlay.EditTag(t.tag)) }, count = t.count)
            }
            Spacer(Modifier.height(16.dp))
        }
    }
}

private fun emptyText(view: String, searching: Boolean): Pair<String, String?> = when {
    searching -> "Nothing found" to "Try other words, or filters like #tag, !1 or due:week."
    view == Views.TODAY -> "Nothing due today" to "Enjoy the day, or add something with the button below."
    view == Views.UPCOMING -> "Nothing coming up" to "Tasks with a due date show up here, day by day."
    view == Views.IMPORTANT -> "Nothing important" to "High-priority tasks show up here."
    else -> "No tasks here" to "Add one with the button below."
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
private fun TaskListPane(vm: TasksViewModel, lists: List<TaskList>, refreshing: Boolean, onOverlay: (Overlay) -> Unit) {
    val sections by vm.sections.collectAsStateWithLifecycle()
    val prefs by vm.prefs.collectAsStateWithLifecycle()
    val searchOpen by vm.searchOpen.collectAsStateWithLifecycle()
    val search by vm.search.collectAsStateWithLifecycle()
    val haptics = LocalHapticFeedback.current
    val view = prefs.view
    val showList = listIdOf(view) == null
    val listById = remember(lists) { lists.associateBy { it.id } }
    val now = remember(sections) { ZonedDateTime.now() }
    val manual = listIdOf(view) != null && vm.sortFor(view) == SortMode.Manual && !(searchOpen && search.isNotBlank())
    val listState = rememberLazyListState()

    // While a row is dragged the open section is shown from a copy that follows the finger.
    val dragRows = remember { mutableStateListOf<TaskRowData>() }
    var dragging by remember { mutableStateOf(false) }
    val reorder = rememberReorderableLazyListState(listState) { from, to ->
        val a = dragRows.indexOfFirst { it.task.id == from.key }
        val b = dragRows.indexOfFirst { it.task.id == to.key }
        // Only among tasks of the same level, so a drag never changes a task's parent.
        if (a >= 0 && b >= 0 && dragRows[a].task.parentUid == dragRows[b].task.parentUid) dragRows.add(b, dragRows.removeAt(a))
    }

    fun complete(t: Task) {
        if (prefs.haptics && !t.completed) haptics.performHapticFeedback(HapticFeedbackType.LongPress)
        vm.toggleComplete(t.id)
    }

    PullToRefreshBox(isRefreshing = refreshing, onRefresh = { vm.sync(manual = true) }, modifier = Modifier.fillMaxSize()) {
        if (sections.all { it.rows.isEmpty() }) {
            val (title, body) = emptyText(view, searchOpen && search.isNotBlank())
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = androidx.compose.foundation.layout.Arrangement.Center) {
                EmptyState(Icons.Outlined.TaskAlt, title, body)
            }
            return@PullToRefreshBox
        }
        LazyColumn(state = listState, modifier = Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 96.dp)) {
            for (section in sections) {
                if (section.rows.isEmpty()) continue
                if (section.title != null) stickyHeader(key = "h:${section.id}", contentType = "header") {
                    Surface(color = MaterialTheme.colorScheme.surface, modifier = Modifier.fillMaxWidth()) {
                        SectionLabel(
                            "${section.title}  ${section.rows.size}",
                            color = when (section.tone) {
                                Tone.Danger -> LocalTaskColors.current.overdue
                                else -> MaterialTheme.colorScheme.onSurfaceVariant
                            },
                        )
                    }
                }
                val reorderable = manual && section.id == "open"
                val rows = if (reorderable && dragging) dragRows else section.rows
                items(rows, key = { it.task.id }, contentType = { "task" }) { row ->
                    val t = row.task
                    val content: @Composable (Modifier, (@Composable () -> Unit)?) -> Unit = { modifier, handle ->
                        SwipeableTask(onComplete = { complete(t) }, onSnooze = { onOverlay(Overlay.Snooze(t.id)) }, completed = t.completed, enabled = !dragging) {
                            TaskRow(
                                row = row,
                                listName = if (showList) listById[t.listId]?.name else null,
                                listColor = if (showList) parseColor(listById[t.listId]?.color) else null,
                                collapsed = t.uid in prefs.collapsed,
                                now = now,
                                onToggle = { complete(t) },
                                onOpen = { vm.detailId.value = t.id },
                                onMenu = { onOverlay(Overlay.Menu(t.id)) },
                                onCollapse = if (!showList) ({ vm.toggleCollapsed(t.uid) }) else null,
                                modifier = modifier,
                                trailing = handle,
                            )
                        }
                    }
                    if (reorderable) {
                        ReorderableItem(reorder, key = t.id) { _ ->
                            content(Modifier) {
                                Icon(
                                    Icons.Default.DragHandle, "Drag to reorder",
                                    Modifier.padding(8.dp).draggableHandle(
                                        onDragStarted = {
                                            dragRows.clear()
                                            dragRows.addAll(section.rows)
                                            dragging = true
                                        },
                                        onDragStopped = {
                                            val index = dragRows.indexOfFirst { it.task.id == t.id }
                                            if (index >= 0) {
                                                val siblings = dragRows.map { it.task }.filter { it.parentUid == t.parentUid && it.listId == t.listId }
                                                vm.reorder(t, siblings.filter { it.id != t.id }, siblings.indexOfFirst { it.id == t.id })
                                            }
                                            dragging = false
                                        },
                                    ),
                                    tint = MaterialTheme.colorScheme.outline,
                                )
                            }
                        }
                    } else content(Modifier.animateItem(), null)
                }
            }
        }
    }
}
