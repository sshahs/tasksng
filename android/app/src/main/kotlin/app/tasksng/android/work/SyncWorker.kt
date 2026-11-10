package app.tasksng.android.work

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import app.tasksng.android.Graph
import app.tasksng.android.widget.TodayWidget
import java.util.concurrent.TimeUnit

/**
 * Syncs while the app is closed, so reminders set on another device are
 * scheduled here and the widget stays current.
 */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        Graph.attach(applicationContext)
        val engine = Graph.ready()
        if (engine.snapshot.value.account == null) return Result.success()
        val outcome = runCatching { engine.syncNow() }.getOrNull()
        runCatching { engine.flush() }
        runCatching { Reminders.reschedule(applicationContext) }
        runCatching { Reminders.showMissed(applicationContext) }
        runCatching { TodayWidget.feed(applicationContext, engine.snapshot.value) }
        // Offline: WorkManager tries again when the network is back.
        return if (outcome?.error != null && engine.status.value.state == "offline" && runAttemptCount < 3) Result.retry() else Result.success()
    }

    companion object {
        private const val PERIODIC = "tasksng-sync"
        private const val ONCE = "tasksng-sync-once"
        private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

        /** [minutes] between background syncs (Android allows no less than 15); 0 turns them off. */
        fun schedule(context: Context, minutes: Int) {
            val work = runCatching { WorkManager.getInstance(context) }.getOrNull() ?: return
            if (minutes <= 0) {
                work.cancelUniqueWork(PERIODIC)
                return
            }
            val request = PeriodicWorkRequestBuilder<SyncWorker>(maxOf(15, minutes).toLong(), TimeUnit.MINUTES).setConstraints(online).build()
            work.enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.UPDATE, request)
        }

        fun runSoon(context: Context) {
            val request = OneTimeWorkRequestBuilder<SyncWorker>().setConstraints(online).build()
            runCatching { WorkManager.getInstance(context).enqueueUniqueWork(ONCE, ExistingWorkPolicy.REPLACE, request) }
        }
    }
}
