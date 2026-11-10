package app.tasksng.android.core

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put

@Serializable
enum class TaskStatus {
    @SerialName("needs-action") NeedsAction,
    @SerialName("in-process") InProcess,
    @SerialName("completed") Completed,
    @SerialName("cancelled") Cancelled;

    val wire: String
        get() = when (this) {
            NeedsAction -> "needs-action"
            InProcess -> "in-process"
            Completed -> "completed"
            Cancelled -> "cancelled"
        }
}

/**
 * A reminder (an iCalendar VALARM): a fixed time (UTC) or an offset in
 * seconds from the due (or start) date; negative means before.
 */
@Serializable(with = ReminderSerializer::class)
sealed interface Reminder {
    data class At(val at: String) : Reminder
    data class Offset(val offset: Long, val related: String = "due") : Reminder
}

object ReminderSerializer : KSerializer<Reminder> {
    override val descriptor: SerialDescriptor = buildClassSerialDescriptor("Reminder")

    override fun deserialize(decoder: Decoder): Reminder {
        val o = (decoder as JsonDecoder).decodeJsonElement().jsonObject
        o["at"]?.let { return Reminder.At(it.jsonPrimitive.content) }
        return Reminder.Offset(o.getValue("offset").jsonPrimitive.long, o["related"]?.jsonPrimitive?.content ?: "due")
    }

    override fun serialize(encoder: Encoder, value: Reminder) {
        (encoder as JsonEncoder).encodeJsonElement(value.toJson())
    }
}

fun Reminder.toJson(): JsonObject = when (this) {
    is Reminder.At -> buildJsonObject { put("at", at) }
    is Reminder.Offset -> buildJsonObject {
        put("offset", offset)
        put("related", related)
    }
}

@Serializable
data class Task(
    /** The resource path on the server; unique per task. */
    val id: String,
    val uid: String,
    val listId: String,
    val summary: String = "",
    val description: String = "",
    val status: TaskStatus = TaskStatus.NeedsAction,
    val completed: Boolean = false,
    val completedAt: String? = null,
    /** 0 = none, 1 (highest) … 9 (lowest). */
    val priority: Int = 0,
    /** `YYYY-MM-DD` (all day), a UTC instant, or a floating local time. */
    val due: String? = null,
    val start: String? = null,
    val categories: List<String> = emptyList(),
    val parentUid: String? = null,
    val rrule: String? = null,
    val created: String? = null,
    val modified: String? = null,
    val sortOrder: Long? = null,
    val reminders: List<Reminder> = emptyList(),
    /** Planned for this time in the day planner (UTC instant). */
    val planned: String? = null,
    val plannedMinutes: Int? = null,
    /** Snoozed: hidden until this moment (UTC instant). */
    val snoozedUntil: String? = null,
    /** Not yet saved to the server. */
    val pending: Boolean = false,
)

@Serializable
data class TaskList(
    val id: String,
    val name: String,
    val color: String? = null,
    val order: Long? = null,
    val readOnly: Boolean = false,
)

@Serializable
data class Account(
    val serverUrl: String,
    val username: String,
    val principalUrl: String = "",
    val homeUrl: String = "",
    val acceptInvalidCerts: Boolean = false,
)

/** A task changed on this device and another one (or deleted on one of them). */
@Serializable
data class ConflictView(
    val id: String,
    val listId: String,
    val mine: Task? = null,
    val theirs: Task? = null,
    val at: String = "",
)

@Serializable
data class Snapshot(
    val revision: Long = 0,
    val account: Account? = null,
    val lists: List<TaskList> = emptyList(),
    val tasks: List<Task> = emptyList(),
    val lastSync: String? = null,
    val pending: Int = 0,
    val conflicts: List<ConflictView> = emptyList(),
)

@Serializable
data class SyncStatus(
    /** `idle`, `syncing`, `offline`, `error`, `auth-required` or `signed-out`. */
    val state: String = "signed-out",
    val message: String? = null,
    val lastSync: String? = null,
    val pending: Int = 0,
)

/** A calendar event shown in the day planner (read only). */
@Serializable
data class CalEvent(
    val id: String,
    val calendarId: String = "",
    val title: String = "",
    val start: String,
    val end: String,
    val allDay: Boolean = false,
    val location: String? = null,
    val color: String? = null,
)

@Serializable
data class EventsResult(
    val events: List<CalEvent> = emptyList(),
    val fetchedAt: String? = null,
    val error: String? = null,
)

@Serializable
data class TaskVersion(val at: String, val source: String, val task: Task)

@Serializable
data class EngineSettings(
    val reminders: Boolean = true,
    /** Seconds relative to the due time for timed tasks without reminders; null = off. */
    val defaultReminder: Long? = 0,
)

@Serializable
data class TaskResult(val task: Task, val advancedTo: String? = null)

@Serializable
data class SyncOutcome(val notices: List<String> = emptyList(), val error: String? = null)

@Serializable
data class UpcomingReminder(val at: Long, val uid: String, val id: String, val title: String, val body: String)

@Serializable
data class DueReminder(val uid: String, val id: String, val title: String, val body: String)

/**
 * A partial update of a task. Only what was set is sent, and a field set to
 * null clears the value on the task.
 */
class TaskPatch private constructor(private val fields: Map<String, kotlinx.serialization.json.JsonElement>) {
    constructor() : this(emptyMap())

    private fun with(name: String, value: kotlinx.serialization.json.JsonElement) = TaskPatch(fields + (name to value))
    private fun text(name: String, v: String?) = with(name, if (v == null) kotlinx.serialization.json.JsonNull else JsonPrimitive(v))

    fun summary(v: String) = with("summary", JsonPrimitive(v))
    fun description(v: String?) = text("description", v?.ifEmpty { null })
    fun status(v: TaskStatus) = with("status", JsonPrimitive(v.wire))
    fun priority(v: Int) = with("priority", JsonPrimitive(v))
    fun due(v: String?) = text("due", v)
    fun start(v: String?) = text("start", v)
    fun categories(v: List<String>) = with("categories", kotlinx.serialization.json.JsonArray(v.map(::JsonPrimitive)))
    fun parentUid(v: String?) = text("parentUid", v)
    fun rrule(v: String?) = text("rrule", v)
    fun sortOrder(v: Long) = with("sortOrder", JsonPrimitive(v))
    fun reminders(v: List<Reminder>) = with("reminders", kotlinx.serialization.json.JsonArray(v.map { it.toJson() }))
    fun planned(v: String?) = text("planned", v)
    fun plannedMinutes(v: Int?) = with("plannedMinutes", if (v == null) kotlinx.serialization.json.JsonNull else JsonPrimitive(v))
    fun snoozedUntil(v: String?) = text("snoozedUntil", v)

    operator fun plus(other: TaskPatch) = TaskPatch(fields + other.fields)
    val isEmpty get() = fields.isEmpty()
    fun has(name: String) = name in fields
    fun toJson() = JsonObject(fields)

    /** What the task looks like right away, before the engine has answered. */
    fun applyTo(t: Task): Task {
        var n = t.copy(pending = true)
        fun str(name: String): String? = (fields[name] as? JsonPrimitive)?.takeIf { it !is kotlinx.serialization.json.JsonNull }?.content
        if (has("summary")) n = n.copy(summary = str("summary") ?: "")
        if (has("description")) n = n.copy(description = str("description") ?: "")
        if (has("status")) {
            val status = TaskStatus.entries.first { it.wire == str("status") }
            // Completing a repeating task moves it on instead; the engine says where.
            if (t.rrule == null || status == TaskStatus.InProcess || status == TaskStatus.NeedsAction) {
                val done = status == TaskStatus.Completed || status == TaskStatus.Cancelled
                n = n.copy(status = status, completed = done, completedAt = if (done) java.time.Instant.now().toString() else null)
            }
        }
        if (has("priority")) n = n.copy(priority = str("priority")?.toIntOrNull() ?: 0)
        if (has("due")) n = n.copy(due = str("due"))
        if (has("start")) n = n.copy(start = str("start"))
        if (has("categories")) n = n.copy(categories = (fields["categories"] as kotlinx.serialization.json.JsonArray).map { it.jsonPrimitive.content })
        if (has("parentUid")) n = n.copy(parentUid = str("parentUid"))
        if (has("rrule")) n = n.copy(rrule = str("rrule"))
        if (has("sortOrder")) n = n.copy(sortOrder = str("sortOrder")?.toLongOrNull())
        if (has("planned")) n = n.copy(planned = str("planned"))
        if (has("plannedMinutes")) n = n.copy(plannedMinutes = str("plannedMinutes")?.toIntOrNull())
        if (has("snoozedUntil")) n = n.copy(snoozedUntil = str("snoozedUntil"))
        return n
    }
}

data class NewTask(
    val summary: String,
    val description: String? = null,
    val priority: Int? = null,
    val due: String? = null,
    val start: String? = null,
    val categories: List<String> = emptyList(),
    val parentUid: String? = null,
    val rrule: String? = null,
    val reminders: List<Reminder> = emptyList(),
    val sortOrder: Long? = null,
) {
    fun toJson() = buildJsonObject {
        put("summary", summary)
        description?.let { put("description", it) }
        priority?.let { put("priority", it) }
        due?.let { put("due", it) }
        start?.let { put("start", it) }
        put("categories", kotlinx.serialization.json.JsonArray(categories.map(::JsonPrimitive)))
        parentUid?.let { put("parentUid", it) }
        rrule?.let { put("rrule", it) }
        put("reminders", kotlinx.serialization.json.JsonArray(reminders.map { it.toJson() }))
        sortOrder?.let { put("sortOrder", it) }
    }
}
