package app.tasksng.android

import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.TileService
import app.tasksng.android.widget.TodayWidget

/** The Quick Settings tile: opens TasksNG with the new task box. */
class AddTaskTile : TileService() {
    override fun onClick() {
        val intent = Intent(this, MainActivity::class.java).setAction(TodayWidget.ACTION_ADD).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 4, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        } else {
            @Suppress("DEPRECATION", "StartActivityAndCollapseDeprecated")
            startActivityAndCollapse(intent)
        }
    }
}
