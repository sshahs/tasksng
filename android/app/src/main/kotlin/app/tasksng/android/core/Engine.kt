package app.tasksng.android.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.concurrent.thread

class EngineException(message: String) : Exception(message)

/** How commands reach the engine; tests put a fake behind it. */
interface Transport {
    fun invoke(cmd: String, args: String): String
    fun nextEvent(timeoutMs: Long): String?
}

object NativeTransport : Transport {
    override fun invoke(cmd: String, args: String) = Native.invoke(cmd, args)
    override fun nextEvent(timeoutMs: Long) = Native.nextEvent(timeoutMs)
}

/**
 * The app's side of the sync engine: commands as suspending calls, and the
 * engine's state (tasks, lists, sync status) as flows kept up to date from
 * its event queue.
 */
class Engine(private val transport: Transport = NativeTransport) {
    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        coerceInputValues = true
    }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private val _snapshot = MutableStateFlow(Snapshot())
    val snapshot: StateFlow<Snapshot> = _snapshot
    private val _status = MutableStateFlow(SyncStatus())
    val status: StateFlow<SyncStatus> = _status
    private val _notices = MutableSharedFlow<String>(extraBufferCapacity = 16)
    /** Messages for the user from background work (rejected changes …). */
    val notices: SharedFlow<String> = _notices
    private val _pushed = MutableSharedFlow<Unit>(extraBufferCapacity = 4)
    /** Local changes reached the server. */
    val pushed: SharedFlow<Unit> = _pushed
    private val _ready = MutableStateFlow(false)
    /** The first snapshot has been read. */
    val ready: StateFlow<Boolean> = _ready

    @Volatile
    private var running = false

    /** Loads the current state and starts listening for changes. */
    fun start() {
        if (running) return
        running = true
        scope.launch(Dispatchers.IO) {
            runCatching { refresh() }
            runCatching { _status.value = call("get_status") }
            _ready.value = true
        }
        thread(name = "tasksng-events", isDaemon = true) {
            while (running) {
                val raw = runCatching { transport.nextEvent(30_000) }.getOrNull() ?: continue
                runCatching { onEvent(json.parseToJsonElement(raw).jsonObject) }
            }
        }
    }

    private fun onEvent(event: JsonObject) {
        val data = event["data"]?.jsonPrimitive?.content.orEmpty()
        when (event["name"]?.jsonPrimitive?.content) {
            "changed" -> runCatching { refreshBlocking() }
            "status" -> if (data.isNotEmpty()) _status.value = json.decodeFromString(data)
            "notices" -> json.decodeFromString<List<String>>(data).forEach { _notices.tryEmit(it) }
            "pushed" -> _pushed.tryEmit(Unit)
        }
    }

    private fun raw(cmd: String, args: JsonObject): JsonElement {
        val out = json.parseToJsonElement(transport.invoke(cmd, args.toString())).jsonObject
        out["error"]?.let { if (it !is JsonNull) throw EngineException(it.jsonPrimitive.content) }
        return out["ok"] ?: JsonNull
    }

    private suspend inline fun <reified T> call(cmd: String, args: JsonObject = JsonObject(emptyMap())): T =
        withContext(Dispatchers.IO) { json.decodeFromJsonElement<T>(raw(cmd, args)) }

    private suspend fun run(cmd: String, args: JsonObject = JsonObject(emptyMap())) {
        withContext(Dispatchers.IO) { raw(cmd, args) }
    }

    private fun refreshBlocking() {
        val out = raw("get_snapshot", buildJsonObject { put("ifNewer", _snapshot.value.revision) })
        if (out !is JsonNull) _snapshot.value = json.decodeFromJsonElement(out)
    }

    /** Reads the engine's state again (it also does so by itself after changes). */
    suspend fun refresh() = withContext(Dispatchers.IO) { refreshBlocking() }

    /** Shows a change in the UI before the engine has answered. */
    fun optimistic(change: (Snapshot) -> Snapshot) {
        _snapshot.value = change(_snapshot.value)
    }

    suspend fun connect(serverUrl: String, username: String, password: String, acceptInvalidCerts: Boolean): SyncOutcome {
        val out = withContext(Dispatchers.IO) {
            raw("connect", buildJsonObject {
                put("serverUrl", serverUrl)
                put("username", username)
                put("password", password)
                put("acceptInvalidCerts", acceptInvalidCerts)
            }).jsonObject
        }
        _snapshot.value = json.decodeFromJsonElement(out.getValue("snapshot"))
        return json.decodeFromJsonElement(out)
    }

    suspend fun restore(password: String?): SyncStatus =
        call("restore", buildJsonObject { put("password", password?.let(::JsonPrimitive) ?: JsonNull) })

    suspend fun signOut() {
        run("sign_out")
        refresh()
    }

    suspend fun syncNow(): SyncOutcome = call<SyncOutcome>("sync_now").also { refresh() }

    suspend fun flush() = run("flush")

    suspend fun createTask(listId: String, task: NewTask): Task {
        val out: TaskResult = call("create_task", buildJsonObject {
            put("listId", listId)
            put("task", task.toJson())
        })
        refresh()
        return out.task
    }

    suspend fun updateTask(id: String, patch: TaskPatch): TaskResult {
        val out: TaskResult = call("update_task", buildJsonObject {
            put("id", id)
            put("patch", patch.toJson())
        })
        refresh()
        return out
    }

    suspend fun updateTasks(updates: List<Pair<String, TaskPatch>>) {
        if (updates.isEmpty()) return
        run("update_tasks", buildJsonObject {
            put("updates", buildJsonArray {
                for ((id, patch) in updates) add(buildJsonObject {
                    put("id", id)
                    put("patch", patch.toJson())
                })
            })
        })
        refresh()
    }

    suspend fun moveTask(id: String, listId: String): Task {
        val out = withContext(Dispatchers.IO) {
            raw("move_task", buildJsonObject {
                put("id", id)
                put("listId", listId)
            }).jsonObject
        }
        refresh()
        return json.decodeFromJsonElement(out.getValue("task"))
    }

    /** Deletes tasks and answers the token that undoes it. */
    suspend fun deleteTasks(ids: List<String>): Long {
        val out = withContext(Dispatchers.IO) {
            raw("delete_tasks", buildJsonObject { put("ids", buildJsonArray { ids.forEach { add(JsonPrimitive(it)) } }) }).jsonObject
        }
        refresh()
        return out.getValue("token").jsonPrimitive.content.toLong()
    }

    suspend fun undoDelete(token: Long) {
        run("undo_delete", buildJsonObject { put("token", token) })
        refresh()
    }

    /** [resolution]: `{"keep":"mine"}`, `{"keep":"theirs"}` or `{"keep":"merge","patch":{…}}`. */
    suspend fun resolveConflict(id: String, resolution: JsonObject) {
        run("resolve_conflict", buildJsonObject {
            put("id", id)
            put("resolution", resolution)
        })
        refresh()
    }

    suspend fun taskHistory(id: String): List<TaskVersion> = call("task_history", buildJsonObject { put("id", id) })

    suspend fun createList(name: String, color: String?) {
        run("create_list", buildJsonObject {
            put("name", name)
            put("color", color?.let(::JsonPrimitive) ?: JsonNull)
        })
        refresh()
    }

    suspend fun updateList(id: String, name: String?, color: String?) {
        run("update_list", buildJsonObject {
            put("id", id)
            put("name", name?.let(::JsonPrimitive) ?: JsonNull)
            put("color", color?.let(::JsonPrimitive) ?: JsonNull)
        })
        refresh()
    }

    suspend fun deleteList(id: String) {
        run("delete_list", buildJsonObject { put("id", id) })
        refresh()
    }

    suspend fun events(from: String, to: String, cachedOnly: Boolean = false): EventsResult =
        call("get_events", buildJsonObject {
            put("from", from)
            put("to", to)
            put("cachedOnly", cachedOnly)
        })

    suspend fun settings(): EngineSettings = call("get_settings")

    suspend fun updateSettings(reminders: Boolean? = null, defaultReminder: Long? = null, clearDefaultReminder: Boolean = false): EngineSettings =
        call("update_settings", buildJsonObject {
            put("patch", buildJsonObject {
                reminders?.let { put("reminders", it) }
                if (clearDefaultReminder) put("defaultReminder", JsonNull) else defaultReminder?.let { put("defaultReminder", it) }
            })
        })

    suspend fun reminderAction(uid: String, action: String, minutes: Int? = null) {
        run("reminder_action", buildJsonObject {
            put("uid", uid)
            put("action", action)
            minutes?.let { put("minutes", it) }
        })
    }

    suspend fun upcomingReminders(days: Int, max: Int): List<UpcomingReminder> =
        call("upcoming_reminders", buildJsonObject {
            put("days", days)
            put("max", max)
        })

    suspend fun dueReminders(): List<DueReminder> = call("due_reminders")
}
