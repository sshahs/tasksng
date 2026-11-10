package app.tasksng.android.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import app.tasksng.android.Graph
import app.tasksng.android.core.Account
import app.tasksng.android.core.ConflictView
import app.tasksng.android.core.EngineException
import app.tasksng.android.core.EngineSettings
import app.tasksng.android.core.NewTask
import app.tasksng.android.core.Snapshot
import app.tasksng.android.core.SyncStatus
import app.tasksng.android.core.Task
import app.tasksng.android.core.TaskList
import app.tasksng.android.core.TaskPatch
import app.tasksng.android.core.TaskStatus
import app.tasksng.android.data.ClaimResult
import app.tasksng.android.data.LinkedServer
import app.tasksng.android.data.PairedAccount
import app.tasksng.android.data.PairingCode
import app.tasksng.android.data.SecretStore
import app.tasksng.android.data.UiPrefs
import app.tasksng.android.data.WebLink
import app.tasksng.android.data.WebLinkException
import app.tasksng.android.logic.QuickAddResult
import app.tasksng.android.logic.SavedSearch
import app.tasksng.android.logic.Section
import app.tasksng.android.logic.SortMode
import app.tasksng.android.logic.TagCount
import app.tasksng.android.logic.ViewId
import app.tasksng.android.logic.ViewOptions
import app.tasksng.android.logic.Views
import app.tasksng.android.logic.buildSections
import app.tasksng.android.logic.comparator
import app.tasksng.android.logic.countOpen
import app.tasksng.android.logic.formatDue
import app.tasksng.android.logic.isInView
import app.tasksng.android.logic.iso
import app.tasksng.android.logic.listIdOf
import app.tasksng.android.logic.manualKey
import app.tasksng.android.logic.nextWake
import app.tasksng.android.logic.parseDue
import app.tasksng.android.logic.parseQuery
import app.tasksng.android.logic.planReorder
import app.tasksng.android.logic.resolveList
import app.tasksng.android.logic.searchIdOf
import app.tasksng.android.logic.snoozeLabel
import app.tasksng.android.logic.tagCounts
import app.tasksng.android.logic.tagOf
import app.tasksng.android.logic.viewQuery
import app.tasksng.android.work.Reminders
import app.tasksng.android.work.SyncWorker
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import java.time.Instant
import java.time.ZonedDateTime
import java.util.UUID

/** A short message at the bottom of the screen, maybe with something to tap. */
class UiMessage(val text: String, val actionLabel: String? = null, val long: Boolean = false, val action: (() -> Unit)? = null)

/** Screens that cover the task list. */
sealed interface Screen {
    data object Main : Screen
    data object Settings : Screen
    data object Conflicts : Screen
    data class Pairing(val code: PairingCode? = null) : Screen
}

/** What the lists drawer shows next to each entry. */
data class DrawerCounts(val views: Map<ViewId, Int> = emptyMap(), val tags: List<TagCount> = emptyList())

class TasksViewModel(app: Application) : AndroidViewModel(app) {
    private val engine = Graph.engine
    private val prefsStore = Graph.prefs

    val ready = MutableStateFlow(false)
    val snapshot: StateFlow<Snapshot> = engine.snapshot
    val status: StateFlow<SyncStatus> = engine.status
    val prefs: StateFlow<UiPrefs> = prefsStore.state
    val settings = MutableStateFlow(EngineSettings())

    val search = MutableStateFlow("")
    val searchOpen = MutableStateFlow(false)
    val screen = MutableStateFlow<Screen>(Screen.Main)
    /** The task whose details are open. */
    val detailId = MutableStateFlow<String?>(null)
    /** Bumped to open the quick add sheet (with some text to start from). */
    val quickAdd = MutableStateFlow<QuickAddRequest?>(null)
    val messages = MutableSharedFlow<UiMessage>(extraBufferCapacity = 8)
    val connecting = MutableStateFlow(false)

    /** Just completed: stay in place for a moment so the tick is seen. */
    private val keep = MutableStateFlow<Set<String>>(emptySet())

    /** Ticks at every full minute (and when a snoozed task comes back), so "Today" and overdue marks stay right. */
    private val clock = flow {
        while (true) {
            emit(Unit)
            val now = ZonedDateTime.now()
            val nextMinute = 60_000L - (now.second * 1000L + now.nano / 1_000_000)
            val wake = nextWake(snapshot.value.tasks, now)?.let { it.toEpochMilli() - Instant.now().toEpochMilli() + 500 }
            delay(minOf(nextMinute, wake ?: Long.MAX_VALUE).coerceAtLeast(500))
        }
    }

    private data class Inputs(val snapshot: Snapshot, val prefs: UiPrefs, val search: String, val keep: Set<String>)

    private val inputs = combine(snapshot, prefs, search, keep, clock) { s, p, q, k, _ -> Inputs(s, p, q, k) }

    val sections: StateFlow<List<Section>> = inputs.combine(searchOpen) { i, open ->
        val view = if (i.prefs.view == Views.PLAN || i.prefs.view == Views.OVERVIEW) Views.TODAY else i.prefs.view
        buildSections(
            view, i.snapshot.tasks,
            ViewOptions(
                search = if (open) i.search else "",
                showCompleted = i.prefs.showCompleted,
                collapsed = i.prefs.collapsed,
                sort = effectiveSort(i.prefs, view),
                lists = i.snapshot.lists,
                savedSearches = i.prefs.savedSearches,
                keep = i.keep,
            ),
        )
    }.flowOn(Dispatchers.Default).stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    val counts: StateFlow<DrawerCounts> = inputs.combine(MutableStateFlow(Unit)) { i, _ ->
        val now = ZonedDateTime.now()
        val tasks = i.snapshot.tasks
        val views = HashMap<ViewId, Int>()
        for ((id, _) in Views.SMART) views[id] = countOpen(id, tasks, now)
        for (l in i.snapshot.lists) views[Views.list(l.id)] = countOpen(Views.list(l.id), tasks, now)
        for (s in i.prefs.savedSearches) views[Views.search(s.id)] = countOpen(Views.search(s.id), tasks, now, i.snapshot.lists, i.prefs.savedSearches)
        DrawerCounts(views, tagCounts(tasks, now))
    }.flowOn(Dispatchers.Default).stateIn(viewModelScope, SharingStarted.Eagerly, DrawerCounts())

    val lists: List<TaskList> get() = sortedLists(snapshot.value.lists)
    val account: Account? get() = snapshot.value.account

    init {
        viewModelScope.launch {
            Graph.ready()
            runCatching { settings.value = engine.settings() }
            // A view pointing at a list that no longer exists falls back to Today.
            if (!knownView(prefs.value.view)) setView(Views.TODAY)
            ready.value = true
        }
        viewModelScope.launch { engine.notices.collect { messages.emit(UiMessage(it, long = true)) } }
        // Say so once when a task first turns out to be changed on two devices.
        viewModelScope.launch {
            var known = emptySet<String>()
            snapshot.collect { s ->
                val fresh = s.conflicts.filter { it.id !in known }
                known = s.conflicts.mapTo(HashSet()) { it.id }
                if (fresh.isNotEmpty() && ready.value) {
                    val title = (fresh[0].mine ?: fresh[0].theirs)?.summary
                    val text = if (fresh.size == 1 && !title.isNullOrEmpty()) "“$title” was changed on two devices" else "Tasks were changed on two devices"
                    messages.emit(UiMessage(text, "Choose", long = true) { screen.value = Screen.Conflicts })
                }
                if (s.conflicts.isEmpty() && screen.value == Screen.Conflicts) screen.value = Screen.Main
                if (detailId.value != null && s.tasks.none { it.id == detailId.value }) detailId.value = null
            }
        }
    }

    private fun knownView(view: ViewId): Boolean {
        listIdOf(view)?.let { id -> return snapshot.value.lists.any { it.id == id } || snapshot.value.account == null }
        searchIdOf(view)?.let { id -> return prefs.value.savedSearches.any { it.id == id } }
        return true
    }

    private fun effectiveSort(p: UiPrefs, view: ViewId): SortMode {
        val mode = p.sortFor(view)
        return if (mode.listsOnly && listIdOf(view) == null) SortMode.Smart else mode
    }

    fun sortFor(view: ViewId): SortMode = effectiveSort(prefs.value, view)

    fun task(id: String?): Task? = id?.let { wanted -> snapshot.value.tasks.firstOrNull { it.id == wanted } }

    private fun say(text: String, long: Boolean = false) {
        messages.tryEmit(UiMessage(text, long = long))
    }

    private fun fail(e: Throwable) = say(e.message ?: "Something went wrong", long = true)

    private fun launch(block: suspend () -> Unit): Job = viewModelScope.launch {
        try {
            block()
        } catch (e: EngineException) {
            fail(e)
            runCatching { engine.refresh() }
        } catch (e: WebLinkException) {
            fail(e)
        }
    }

    // -----------------------------------------------------------------------
    // Views

    fun setView(view: ViewId) {
        prefsStore.update { it.copy(view = view) }
        search.value = ""
        searchOpen.value = false
    }

    fun setSort(mode: SortMode) = prefsStore.update { it.copy(sorts = it.sorts + (it.view to mode.id)) }
    fun toggleShowCompleted() = prefsStore.update { it.copy(showCompleted = !it.showCompleted) }
    fun toggleCollapsed(uid: String) = prefsStore.update { it.copy(collapsed = if (uid in it.collapsed) it.collapsed - uid else it.collapsed + uid) }
    fun updatePrefs(change: (UiPrefs) -> UiPrefs) {
        val before = prefs.value.backgroundSync
        prefsStore.update(change)
        if (prefs.value.backgroundSync != before) SyncWorker.schedule(getApplication(), prefs.value.backgroundSync)
    }

    /** Shows a task, switching to its list when the current view hides it. */
    fun openTask(id: String) {
        val t = task(id) ?: return
        val p = prefs.value
        if (p.view == Views.PLAN || p.view == Views.OVERVIEW || !isInView(p.view, t, ZonedDateTime.now(), snapshot.value.lists, p.savedSearches)) {
            if (p.view != Views.PLAN) setView(Views.list(t.listId))
        }
        screen.value = Screen.Main
        detailId.value = id
    }

    fun openTaskByUid(uid: String) {
        snapshot.value.tasks.firstOrNull { it.uid == uid }?.let { openTask(it.id) }
    }

    // -----------------------------------------------------------------------
    // Account and sync

    fun connect(serverUrl: String, username: String, password: String, acceptInvalidCerts: Boolean, done: (String?) -> Unit = {}) {
        viewModelScope.launch {
            connecting.value = true
            try {
                val out = engine.connect(serverUrl, username, password, acceptInvalidCerts)
                Graph.secrets.put(SecretStore.PASSWORD, password)
                if (prefs.value.defaultList == null) {
                    snapshot.value.lists.firstOrNull { !it.readOnly }?.let { first -> prefsStore.update { it.copy(defaultList = first.id) } }
                }
                out.error?.let { say(it, long = true) }
                setView(Views.TODAY)
                done(null)
            } catch (e: EngineException) {
                done(e.message)
            } finally {
                connecting.value = false
            }
        }
    }

    fun signOut() = launch {
        for (server in prefs.value.linked) unlinkQuietly(server)
        engine.signOut()
        Graph.secrets.remove(SecretStore.PASSWORD)
        prefsStore.update { it.copy(linked = emptyList(), view = Views.TODAY, defaultList = null) }
        detailId.value = null
        screen.value = Screen.Main
        Reminders.reschedule(getApplication())
    }

    private var syncing: Job? = null

    fun sync(manual: Boolean = false) {
        if (account == null || syncing?.isActive == true) return
        syncing = viewModelScope.launch {
            try {
                val out = engine.syncNow()
                out.notices.forEach { say(it, long = true) }
                if (manual && out.error != null) {
                    if (status.value.state == "offline") say("Can't reach your server. Changes are kept on this phone and sync when it's back.", long = true)
                    else say(out.error, long = true)
                }
                Reminders.showMissed(getApplication())
            } catch (e: EngineException) {
                if (manual) fail(e)
            }
        }
    }

    // -----------------------------------------------------------------------
    // Tasks

    fun defaultListId(): String? {
        val writable = snapshot.value.lists.filter { !it.readOnly }
        listIdOf(prefs.value.view)?.let { id -> if (writable.any { it.id == id }) return id }
        prefs.value.defaultList?.let { id -> if (writable.any { it.id == id }) return id }
        return sortedLists(writable).firstOrNull()?.id
    }

    /** What a new task gets from the view it is added in (a tag view tags it, Today makes it due today …). */
    fun viewDefaults(parsed: QuickAddResult): QuickAddResult {
        val view = prefs.value.view
        val today = ZonedDateTime.now().toLocalDate()
        var out = parsed
        val q = viewQuery(view, prefs.value.savedSearches)
        if (q != null) {
            val tags = q.defaults.tags.filter { t -> out.categories.none { it.equals(t, ignoreCase = true) } }
            out = out.copy(
                categories = out.categories + tags,
                priority = out.priority ?: q.defaults.priority,
                due = out.due ?: when (q.defaults.due) {
                    "today" -> today.toString()
                    "tomorrow" -> today.plusDays(1).toString()
                    else -> null
                },
                list = out.list ?: q.defaults.list,
            )
        } else if (out.due == null && out.start == null) {
            if (view == Views.TODAY || view == Views.PLAN) out = out.copy(due = today.toString())
            if (view == Views.IMPORTANT && out.priority == null) out = out.copy(priority = 1)
        } else if (view == Views.IMPORTANT && out.priority == null) out = out.copy(priority = 1)
        return out
    }

    fun createFromQuickAdd(parsed: QuickAddResult, listId: String?, parentUid: String? = null, description: String? = null, then: (Task) -> Unit = {}) {
        val p = if (parentUid == null) viewDefaults(parsed) else parsed
        val target = resolveList(p.list, snapshot.value.lists.filter { !it.readOnly })?.id ?: listId ?: defaultListId()
        if (target == null) {
            say("There is no list to add tasks to yet")
            return
        }
        if (p.summary.isBlank()) return
        // New tasks go to the end in manual order.
        val last = if (sortFor(Views.list(target)) == SortMode.Manual) {
            snapshot.value.tasks.filter { it.listId == target && it.parentUid == parentUid }.maxOfOrNull(::manualKey)?.plus(1024)
        } else null
        launch {
            val task = engine.createTask(
                target,
                NewTask(
                    summary = p.summary, description = description, priority = p.priority, due = p.due, start = p.start,
                    categories = p.categories, parentUid = parentUid, rrule = p.rrule, sortOrder = last,
                ),
            )
            then(task)
            if (parentUid == null && !isInView(prefs.value.view, task, ZonedDateTime.now(), snapshot.value.lists, prefs.value.savedSearches) &&
                prefs.value.view != Views.PLAN && prefs.value.view != Views.OVERVIEW
            ) {
                val list = snapshot.value.lists.firstOrNull { it.id == task.listId }?.name ?: "its list"
                messages.emit(UiMessage("Added to $list", "Show") { openTask(task.id) })
            }
        }
    }

    fun update(id: String, patch: TaskPatch) {
        val before = task(id) ?: return
        if (patch.isEmpty) return
        engine.optimistic { s -> s.copy(tasks = s.tasks.map { if (it.id == id) patch.applyTo(it) else it }) }
        launch {
            val out = engine.updateTask(id, patch)
            out.advancedTo?.let { next -> say("Repeats — next due ${parseDue(next)?.let { formatDue(it) } ?: next}") }
        }.invokeOnCompletion { if (it != null) engine.optimistic { s -> s.copy(tasks = s.tasks.map { t -> if (t.id == id) before else t }) } }
    }

    fun updateAll(updates: List<Pair<String, TaskPatch>>) {
        if (updates.isEmpty()) return
        val patches = updates.toMap()
        engine.optimistic { s -> s.copy(tasks = s.tasks.map { t -> patches[t.id]?.applyTo(t) ?: t }) }
        launch { engine.updateTasks(updates) }
    }

    fun toggleComplete(id: String) {
        val t = task(id) ?: return
        if (!t.completed && !prefs.value.showCompleted) {
            keep.value += id
            viewModelScope.launch {
                delay(900)
                keep.value -= id
            }
        }
        update(id, TaskPatch().status(if (t.completed) TaskStatus.NeedsAction else TaskStatus.Completed))
    }

    fun delete(ids: List<String>) {
        val victims = ids.mapNotNull(::task)
        if (victims.isEmpty()) return
        val label = if (victims.size == 1) "“${victims[0].summary.ifEmpty { "Untitled" }}”" else "${victims.size} tasks"
        if (detailId.value in ids) detailId.value = null
        launch {
            val token = engine.deleteTasks(ids)
            messages.emit(UiMessage("Deleted $label", "Undo") { launch { engine.undoDelete(token) } })
        }
    }

    /** Deletes a task together with its subtasks. */
    fun deleteWithSubtasks(id: String) {
        val t = task(id) ?: return
        val all = snapshot.value.tasks
        val ids = mutableListOf(id)
        var frontier = listOf(t.uid)
        while (frontier.isNotEmpty()) {
            val kids = all.filter { it.listId == t.listId && it.parentUid in frontier && it.id !in ids }
            ids += kids.map { it.id }
            frontier = kids.map { it.uid }
        }
        delete(ids)
    }

    /** Hides a task until [until] (or brings it back with null), with Undo. */
    fun snooze(id: String, until: Instant?) {
        val t = task(id) ?: return
        val before = t.snoozedUntil
        val value = until?.let(::iso)
        if (value != null && detailId.value == id) detailId.value = null
        update(id, TaskPatch().snoozedUntil(value))
        if (value != null) {
            messages.tryEmit(UiMessage("Snoozed ${snoozeLabel(value)}", "Undo") { update(id, TaskPatch().snoozedUntil(before)) })
        }
    }

    fun move(id: String, listId: String) {
        val wasOpen = detailId.value == id
        launch {
            val moved = engine.moveTask(id, listId)
            // The task gets a new id in the target list; keep it open.
            if (wasOpen) detailId.value = moved.id
        }
    }

    fun duplicate(id: String) {
        val t = task(id) ?: return
        launch {
            val copy = engine.createTask(
                t.listId,
                NewTask(
                    summary = t.summary, description = t.description.ifEmpty { null }, priority = t.priority.takeIf { it > 0 }, due = t.due, start = t.start,
                    categories = t.categories, parentUid = t.parentUid, rrule = t.rrule, reminders = t.reminders,
                ),
            )
            messages.emit(UiMessage("Duplicated", "Open") { detailId.value = copy.id })
        }
    }

    /** Puts a task at [index] among the rows of its level (manual order). */
    fun reorder(moving: Task, siblings: List<Task>, index: Int) {
        updateAll(planReorder(siblings, moving, index, moving.parentUid))
    }

    /** Makes a task a subtask of [parent] (or a top-level task with null). */
    fun setParent(id: String, parent: Task?) {
        val t = task(id) ?: return
        if (parent != null && (parent.id == id || parent.listId != t.listId)) return
        // Never under one of its own subtasks.
        var up = parent
        val all = snapshot.value.tasks
        while (up != null) {
            if (up.uid == t.uid) return
            up = up.parentUid?.let { p -> all.firstOrNull { it.uid == p && it.listId == t.listId } }
        }
        update(id, TaskPatch().parentUid(parent?.uid))
    }

    /** The calendar events of a day: what was downloaded before at once, then fresh. */
    suspend fun events(from: String, to: String, cachedOnly: Boolean) =
        runCatching { engine.events(from, to, cachedOnly) }.getOrDefault(app.tasksng.android.core.EventsResult())

    fun plan(id: String, at: Instant?, minutes: Int?) = update(id, TaskPatch().planned(at?.let(::iso)).plannedMinutes(minutes))

    fun resolveConflict(c: ConflictView, resolution: JsonObject) = launch { engine.resolveConflict(c.id, resolution) }

    suspend fun history(id: String) = runCatching { engine.taskHistory(id) }.getOrDefault(emptyList())

    fun restoreVersion(id: String, patch: TaskPatch) {
        val current = task(id) ?: return
        val undo = app.tasksng.android.logic.restorePatch(patch.applyTo(current), current)
        update(id, patch)
        messages.tryEmit(UiMessage("Restored the earlier version", if (undo != null) "Undo" else null) { undo?.let { update(id, it) } })
    }

    // -----------------------------------------------------------------------
    // Lists, tags, saved searches

    fun createList(name: String, color: String?, done: (String?) -> Unit) = viewModelScope.launch {
        try {
            val known = snapshot.value.lists.mapTo(HashSet()) { it.id }
            engine.createList(name, color)
            snapshot.value.lists.firstOrNull { it.id !in known }?.let { setView(Views.list(it.id)) }
            done(null)
        } catch (e: EngineException) {
            done(e.message)
        }
    }

    fun updateList(id: String, name: String?, color: String?, done: (String?) -> Unit) = viewModelScope.launch {
        try {
            engine.updateList(id, name, color)
            done(null)
        } catch (e: EngineException) {
            done(e.message)
        }
    }

    fun deleteList(id: String) = launch {
        engine.deleteList(id)
        if (listIdOf(prefs.value.view) == id) setView(Views.TODAY)
        if (prefs.value.defaultList == id) prefsStore.update { it.copy(defaultList = null) }
    }

    fun saveSearch(name: String, query: String) {
        val s = SavedSearch(UUID.randomUUID().toString(), name.trim().ifEmpty { query.trim() }, query.trim())
        prefsStore.update { it.copy(savedSearches = it.savedSearches + s) }
        setView(Views.search(s.id))
    }

    fun updateSavedSearch(id: String, name: String, query: String) = prefsStore.update { p ->
        p.copy(savedSearches = p.savedSearches.map { if (it.id == id) it.copy(name = name.trim().ifEmpty { query.trim() }, query = query.trim()) else it })
    }

    fun deleteSavedSearch(id: String) {
        prefsStore.update { p -> p.copy(savedSearches = p.savedSearches.filter { it.id != id }) }
        if (searchIdOf(prefs.value.view) == id) setView(Views.TODAY)
    }

    private fun writable(): Set<String> = snapshot.value.lists.filter { !it.readOnly }.mapTo(HashSet()) { it.id }

    fun renameTag(from: String, to: String) {
        val name = to.trim().removePrefix("#")
        if (name.isEmpty() || name == from) return
        val ok = writable()
        val updates = snapshot.value.tasks.filter { t -> t.listId in ok && t.categories.any { it.equals(from, ignoreCase = true) } }.map { t ->
            val categories = mutableListOf<String>()
            for (c in t.categories) {
                val v = if (c.equals(from, ignoreCase = true)) name else c
                if (categories.none { it.equals(v, ignoreCase = true) }) categories += v
            }
            t.id to TaskPatch().categories(categories)
        }
        updateAll(updates)
        if (tagOf(prefs.value.view)?.equals(from, ignoreCase = true) == true) setView(Views.tag(name))
    }

    fun removeTag(tag: String) {
        val ok = writable()
        updateAll(
            snapshot.value.tasks.filter { t -> t.listId in ok && t.categories.any { it.equals(tag, ignoreCase = true) } }
                .map { t -> t.id to TaskPatch().categories(t.categories.filter { !it.equals(tag, ignoreCase = true) }) },
        )
        if (tagOf(prefs.value.view)?.equals(tag, ignoreCase = true) == true) setView(Views.TODAY)
    }

    // -----------------------------------------------------------------------
    // Settings

    fun setReminders(on: Boolean) = launch {
        settings.value = engine.updateSettings(reminders = on)
        Reminders.reschedule(getApplication())
    }

    fun setDefaultReminder(offset: Long?) = launch {
        settings.value = if (offset == null) engine.updateSettings(clearDefaultReminder = true) else engine.updateSettings(defaultReminder = offset)
        Reminders.reschedule(getApplication())
    }

    // -----------------------------------------------------------------------
    // Pairing with the web app

    private suspend fun unlinkQuietly(server: LinkedServer) {
        val token = Graph.secrets.get(SecretStore.deviceToken(server.deviceId))
        if (token != null) runCatching { WebLink.unlink(server.baseUrl, token) }
        Graph.secrets.remove(SecretStore.deviceToken(server.deviceId))
    }

    private fun remember(code: PairingCode, claim: ClaimResult) {
        Graph.secrets.put(SecretStore.deviceToken(claim.deviceId), claim.token)
        val server = LinkedServer(code.baseUrl, claim.deviceId, Graph.deviceName, iso(Instant.now()))
        prefsStore.update { p -> p.copy(linked = p.linked.filter { it.baseUrl != code.baseUrl } + server) }
    }

    /** Uses a pairing code: links this phone, or signs in the browser that shows it. Answers an error message or null. */
    suspend fun usePairingCode(code: PairingCode): String? = withContext(Dispatchers.Default) {
        try {
            val signedIn = account
            val linked = prefs.value.linked.firstOrNull { it.baseUrl == code.baseUrl }
            if (code.mode == "login") {
                if (signedIn == null) return@withContext "Sign in on this phone first, then scan the code again."
                val token = linked?.let { Graph.secrets.get(SecretStore.deviceToken(it.deviceId)) }
                val password = Graph.secrets.get(SecretStore.PASSWORD)
                if (token == null && password == null) return@withContext "Sign in on this phone again first: its password is no longer stored."
                val mine = PairedAccount(signedIn.serverUrl, signedIn.username, password.orEmpty(), signedIn.acceptInvalidCerts)
                WebLink.approveLogin(code, token, if (token == null) mine else null, Graph.deviceName)?.let { remember(code, it) }
                return@withContext null
            }
            // Pairing again replaces the earlier link.
            linked?.let { unlinkQuietly(it) }
            val claim = WebLink.claim(code, Graph.deviceName)
            val theirs = claim.account
            if (signedIn == null) {
                if (theirs == null) return@withContext "The web app didn't send an account to sign in to."
                engine.connect(theirs.serverUrl, theirs.username, theirs.password, theirs.acceptInvalidCerts)
                Graph.secrets.put(SecretStore.PASSWORD, theirs.password)
                snapshot.value.lists.firstOrNull { !it.readOnly }?.let { first -> prefsStore.update { it.copy(defaultList = first.id) } }
            } else if (theirs != null && !theirs.username.equals(signedIn.username, ignoreCase = true)) {
                runCatching { WebLink.unlink(code.baseUrl, claim.token) }
                return@withContext "This phone is signed in as ${signedIn.username}, the web app as ${theirs.username}. Sign out here first to pair with that account."
            }
            remember(code, claim)
            null
        } catch (e: WebLinkException) {
            e.message
        } catch (e: EngineException) {
            e.message
        }
    }

    fun unlink(server: LinkedServer) = launch {
        unlinkQuietly(server)
        prefsStore.update { p -> p.copy(linked = p.linked.filter { it.deviceId != server.deviceId }) }
        say("No longer paired with ${server.baseUrl.substringAfter("://")}")
    }

    /** The web app removed this phone: forget it here as well. */
    fun forgetLink(server: LinkedServer) {
        Graph.secrets.remove(SecretStore.deviceToken(server.deviceId))
        prefsStore.update { p -> p.copy(linked = p.linked.filter { it.deviceId != server.deviceId }) }
    }

    companion object {
        fun sortedLists(lists: List<TaskList>): List<TaskList> =
            lists.sortedWith(compareBy<TaskList> { it.order ?: 1_000_000_000L }.thenBy(String.CASE_INSENSITIVE_ORDER) { it.name })
    }
}

class QuickAddRequest(val text: String = "", val notes: String? = null, val parent: Task? = null, val id: Long = System.nanoTime())
