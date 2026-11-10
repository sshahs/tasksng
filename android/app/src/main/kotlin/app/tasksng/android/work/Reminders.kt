package app.tasksng.android.work

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import app.tasksng.android.Graph
import app.tasksng.android.MainActivity
import app.tasksng.android.R
import app.tasksng.android.core.UpcomingReminder
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Reminders are handed to Android's alarm service, so they appear on time
 * while TasksNG isn't running. The list is rebuilt shortly after every change.
 *
 * Which reminders the system was given is remembered, so the check for
 * missed ones doesn't show them a second time.
 */
object Reminders {
    const val CHANNEL = "reminders"
    const val ACTION_FIRE = "app.tasksng.android.reminder.FIRE"
    const val ACTION_DONE = "app.tasksng.android.reminder.DONE"
    const val ACTION_SNOOZE = "app.tasksng.android.reminder.SNOOZE"
    const val EXTRA_ID = "id"
    const val EXTRA_UID = "uid"
    const val EXTRA_TASK = "taskId"
    const val EXTRA_TITLE = "title"
    const val EXTRA_BODY = "body"

    /** How far ahead reminders are given to the system. Every sync and every change moves the window along. */
    private const val HORIZON_DAYS = 30
    /** Keeps the number of system alarms well below Android's limit (500). */
    private const val MAX_SCHEDULED = 150
    /** How long a delivered reminder is remembered. */
    private const val KEEP_MS = 48 * 3600_000L
    private const val ICON_COLOR = 0xFF2563EB.toInt()

    @Serializable
    private data class Entry(val uid: String, val at: Long, /** Changes when the title or text does, which needs a new alarm. */ val sig: Int)

    private val json = Json { ignoreUnknownKeys = true }
    private val lock = Mutex()

    private fun prefs(context: Context) = context.getSharedPreferences("tasksng-reminders", Context.MODE_PRIVATE)

    private fun load(context: Context): MutableMap<Int, Entry> =
        prefs(context).getString("scheduled", null)?.let { runCatching { json.decodeFromString<Map<Int, Entry>>(it) }.getOrNull() }?.toMutableMap()
            ?: mutableMapOf()

    private fun save(context: Context, entries: Map<Int, Entry>) {
        prefs(context).edit().putString("scheduled", json.encodeToString(entries)).apply()
    }

    /** FNV-1a: notification ids have to be stable across starts. */
    private fun hash(s: String): Int {
        var h = 0x811c9dc5.toInt()
        for (b in s.toByteArray()) h = (h xor (b.toInt() and 0xff)) * 0x01000193
        return h
    }

    fun notificationId(key: String): Int = hash(key) and 0x7fffffff

    fun ensureChannel(context: Context) {
        val channel = NotificationChannel(CHANNEL, "Reminders", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Reminders for your tasks"
            enableVibration(true)
        }
        context.getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
    }

    fun canNotify(context: Context): Boolean =
        NotificationManagerCompat.from(context).areNotificationsEnabled() &&
            (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)

    private fun firePending(context: Context, id: Int, r: UpcomingReminder?, flags: Int): PendingIntent? {
        val intent = Intent(context, ReminderReceiver::class.java).setAction(ACTION_FIRE).setData(Uri.parse("tasksng://reminder/$id"))
        if (r != null) {
            intent.putExtra(EXTRA_ID, id).putExtra(EXTRA_UID, r.uid).putExtra(EXTRA_TASK, r.id).putExtra(EXTRA_TITLE, r.title).putExtra(EXTRA_BODY, r.body)
        }
        return PendingIntent.getBroadcast(context, id, intent, flags or PendingIntent.FLAG_IMMUTABLE)
    }

    /** Brings the system's alarms up to date with the tasks. */
    suspend fun reschedule(context: Context) = lock.withLock {
        val engine = Graph.ready()
        val alarms = context.getSystemService(AlarmManager::class.java) ?: return@withLock
        val now = System.currentTimeMillis()
        // Without permission the system wouldn't show them; the next start asks again.
        val planned = if (engine.snapshot.value.account != null && canNotify(context)) {
            runCatching { engine.upcomingReminders(HORIZON_DAYS, MAX_SCHEDULED) }.getOrDefault(emptyList())
        } else emptyList()
        val wanted = planned.associateBy({ notificationId("${it.uid}@${it.at / 1000}") }) { it }
        val entries = load(context)

        // Alarms still to come that are no longer wanted (completed, moved …).
        // Ones that went off stay: cancelling would also take them out of the
        // notification shade.
        val stale = entries.filter { (id, e) ->
            e.at > now && wanted[id]?.let { it.at == e.at && it.uid == e.uid && hash("${it.title}\n${it.body}") == e.sig } != true
        }.keys
        for (id in stale) {
            firePending(context, id, null, PendingIntent.FLAG_NO_CREATE)?.let {
                alarms.cancel(it)
                it.cancel()
            }
            entries.remove(id)
        }

        val exact = Build.VERSION.SDK_INT < 31 || alarms.canScheduleExactAlarms()
        for ((id, r) in wanted) {
            val entry = Entry(r.uid, r.at, hash("${r.title}\n${r.body}"))
            if (entries[id] == entry) continue
            val pending = firePending(context, id, r, PendingIntent.FLAG_UPDATE_CURRENT) ?: continue
            runCatching {
                if (exact) alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, r.at, pending)
                else alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, r.at, pending)
                entries[id] = entry
            }
        }
        entries.entries.removeAll { it.value.at <= now - KEEP_MS }
        save(context, entries)
    }

    /** Whether the system has shown this task's reminder recently. */
    private fun deliveredBySystem(context: Context, uid: String, now: Long): Boolean =
        load(context).values.any { it.uid == uid && it.at <= now && it.at > now - 24 * 3600_000L }

    /** Shows reminders that are due and were never given to the system (synced from another device after their time). */
    suspend fun showMissed(context: Context) {
        val engine = Graph.ready()
        if (engine.snapshot.value.account == null || !canNotify(context)) return
        val now = System.currentTimeMillis()
        val due = runCatching { engine.dueReminders() }.getOrDefault(emptyList()).filter { !deliveredBySystem(context, it.uid, now) }
        if (due.size > 3) {
            show(context, notificationId("summary:$now"), null, null, "${due.size} reminders", due.take(3).joinToString(", ") { it.title } + ", …")
        } else {
            for (d in due) show(context, notificationId("now:${d.uid}:$now"), d.uid, d.id, d.title, d.body)
        }
    }

    private fun action(context: Context, action: String, id: Int, uid: String): PendingIntent {
        val intent = Intent(context, ReminderReceiver::class.java).setAction(action).setData(Uri.parse("tasksng://reminder/$id/$action"))
            .putExtra(EXTRA_ID, id).putExtra(EXTRA_UID, uid)
        return PendingIntent.getBroadcast(context, id, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    /** Shows a reminder now. With a [uid] it gets the Snooze and Done buttons. */
    fun show(context: Context, id: Int, uid: String?, taskId: String?, title: String, body: String) {
        if (!canNotify(context)) return
        val open = Intent(context, MainActivity::class.java).setAction(MainActivity.ACTION_OPEN_TASK).setData(Uri.parse("tasksng://open/$id"))
            .putExtra(EXTRA_TASK, taskId).putExtra(EXTRA_UID, uid).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val builder = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_tasksng)
            .setColor(ICON_COLOR)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(PendingIntent.getActivity(context, id, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        if (!uid.isNullOrEmpty()) {
            builder.addAction(0, "Snooze 10 min", action(context, ACTION_SNOOZE, id, uid))
            builder.addAction(0, "Done", action(context, ACTION_DONE, id, uid))
        }
        runCatching { NotificationManagerCompat.from(context).notify(id, builder.build()) }
    }

    /** A sample, so people can check notifications are allowed. */
    fun showTest(context: Context) {
        show(context, notificationId("test"), "", null, "This is how reminders look", "Snooze or complete tasks right from the notification.")
    }
}

class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Graph.attach(context)
        val id = intent.getIntExtra(Reminders.EXTRA_ID, 0)
        val uid = intent.getStringExtra(Reminders.EXTRA_UID).orEmpty()
        when (intent.action) {
            Reminders.ACTION_FIRE -> Reminders.show(
                context, id, uid, intent.getStringExtra(Reminders.EXTRA_TASK),
                intent.getStringExtra(Reminders.EXTRA_TITLE) ?: "Reminder", intent.getStringExtra(Reminders.EXTRA_BODY).orEmpty(),
            )
            Reminders.ACTION_DONE, Reminders.ACTION_SNOOZE -> {
                NotificationManagerCompat.from(context).cancel(id)
                if (uid.isEmpty()) return
                val pending = goAsync()
                Graph.scope.launch {
                    try {
                        val engine = Graph.ready()
                        if (intent.action == Reminders.ACTION_DONE) engine.reminderAction(uid, "done") else engine.reminderAction(uid, "snooze", 10)
                        engine.flush()
                        Reminders.reschedule(context)
                        // The change still has to reach the server, also when the process is stopped right away.
                        SyncWorker.runSoon(context)
                    } finally {
                        pending.finish()
                    }
                }
            }
        }
    }
}

/** Alarms don't survive a restart (or an update of the app): hand them to the system again. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Graph.attach(context)
        val pending = goAsync()
        Graph.scope.launch {
            try {
                context.getSharedPreferences("tasksng-reminders", Context.MODE_PRIVATE).edit().remove("scheduled").apply()
                Reminders.reschedule(context)
            } finally {
                pending.finish()
            }
        }
    }
}
