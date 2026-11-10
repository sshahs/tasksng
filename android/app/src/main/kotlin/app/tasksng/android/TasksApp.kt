package app.tasksng.android

import android.app.Application
import app.tasksng.android.work.Reminders
import app.tasksng.android.work.SyncWorker

class TasksApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Graph.attach(this)
        Reminders.ensureChannel(this)
        SyncWorker.schedule(this, Graph.prefs.value.backgroundSync)
    }
}
