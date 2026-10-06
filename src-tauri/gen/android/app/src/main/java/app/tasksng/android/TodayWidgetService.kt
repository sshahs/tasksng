package app.tasksng.android

import android.content.Context
import android.content.Intent
import android.widget.RemoteViews
import android.widget.RemoteViewsService

/** The rows of the "Today" widget's list. */
class TodayWidgetService : RemoteViewsService() {
  override fun onGetViewFactory(intent: Intent): RemoteViewsFactory = Factory(applicationContext)

  private class Factory(private val context: Context) : RemoteViewsFactory {
    private var rows: List<TodayWidget.Row> = emptyList()

    override fun onCreate() {}

    override fun onDataSetChanged() {
      rows = TodayWidget.rows(context)
    }

    override fun onDestroy() {}

    override fun getCount(): Int = rows.size

    override fun getViewAt(position: Int): RemoteViews {
      val views = RemoteViews(context.packageName, R.layout.widget_today_item)
      val row = rows.getOrNull(position) ?: return views
      views.setTextViewText(R.id.item_title, row.title)
      views.setTextViewText(R.id.item_meta, row.meta)
      views.setTextColor(
        R.id.item_meta,
        context.getColor(if (row.overdue) R.color.widget_overdue else R.color.widget_text_secondary),
      )
      views.setInt(R.id.item_dot, "setColorFilter", row.color)
      // High priority gets a red flag, like in the app.
      views.setTextViewText(R.id.item_flag, if (row.priority in 1..4) "⚑" else "")
      views.setTextColor(R.id.item_flag, context.getColor(R.color.widget_overdue))
      views.setOnClickFillInIntent(R.id.item_root, Intent().putExtra(TodayWidget.EXTRA_TASK, row.id))
      return views
    }

    override fun getLoadingView(): RemoteViews? = null

    override fun getViewTypeCount(): Int = 1

    override fun getItemId(position: Int): Long = rows.getOrNull(position)?.id?.hashCode()?.toLong() ?: position.toLong()

    override fun hasStableIds(): Boolean = true
  }
}
