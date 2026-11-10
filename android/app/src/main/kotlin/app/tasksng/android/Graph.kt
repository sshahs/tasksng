package app.tasksng.android

import android.content.Context
import android.os.Build
import app.tasksng.android.core.Engine
import app.tasksng.android.core.Native
import app.tasksng.android.data.Prefs
import app.tasksng.android.data.SecretStore
import app.tasksng.android.data.WebLink
import app.tasksng.android.widget.TodayWidget
import app.tasksng.android.work.Reminders
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File

/**
 * What the whole process shares: the engine, preferences and secrets. The
 * activity, the reminder receiver, the sync worker and the widget all start
 * from here, whichever of them Android starts the process for.
 */
object Graph {
    lateinit var app: Context
        private set
    val prefs: Prefs by lazy { Prefs(app) }
    val secrets: SecretStore by lazy { SecretStore(app) }
    val engine = Engine()
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private val startLock = Mutex()
    @Volatile
    private var started = false
    /** Why the engine couldn't be started, for the UI to show. */
    @Volatile
    var startError: String? = null
        private set

    fun attach(context: Context) {
        if (!::app.isInitialized) app = context.applicationContext
    }

    val deviceName: String
        get() = listOfNotNull(Build.MANUFACTURER?.replaceFirstChar { it.uppercase() }, Build.MODEL)
            .joinToString(" ").ifBlank { "Android phone" }.let { if (Build.MODEL?.startsWith(Build.MANUFACTURER ?: "\u0000", ignoreCase = true) == true) Build.MODEL else it }

    /** Opens the task cache (once per process) and answers the engine. */
    suspend fun ready(): Engine {
        if (started) return engine
        startLock.withLock {
            if (started) return engine
            withContext(Dispatchers.IO) {
                val dir = File(app.filesDir, "engine")
                val out = runCatching { Native.init(dir.absolutePath, secrets.get(SecretStore.PASSWORD)) }
                    .getOrElse { """{"error":"${it.message?.replace("\"", "'")}"}""" }
                if (out.contains("\"error\"")) startError = out
            }
            engine.start()
            engine.ready.first { it }
            watch()
            started = true
        }
        return engine
    }

    /** Keeps Android's alarms, the widget and paired browsers in step with the tasks. */
    @OptIn(FlowPreview::class)
    private fun watch() {
        scope.launch {
            engine.snapshot.debounce(800).collect {
                runCatching { Reminders.reschedule(app) }
                runCatching { TodayWidget.feed(app, it) }
            }
        }
        scope.launch {
            engine.pushed.collect {
                for (server in prefs.value.linked) {
                    val token = secrets.get(SecretStore.deviceToken(server.deviceId)) ?: continue
                    runCatching { WebLink.poke(server.baseUrl, token) }
                }
            }
        }
    }
}
