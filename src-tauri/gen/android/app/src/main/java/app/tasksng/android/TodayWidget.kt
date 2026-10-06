package app.tasksng.android

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.widget.RemoteViews
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import org.json.JSONArray

/**
 * The "Today" home screen widget. The app hands it the open tasks of the
 * coming week whenever they change (MainActivity: updateWidget); the widget
 * picks today's from them each time it draws, so it stays right after
 * midnight even when TasksNG hasn't been opened.
 */
class TodayWidget : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    for (id in ids) draw(context, manager, id)
    manager.notifyAppWidgetViewDataChanged(ids, R.id.widget_list)
    scheduleMidnight(context)
  }

  override fun onReceive(context: Context, intent: Intent) {
    super.onReceive(context, intent)
    if (intent.action == ACTION_REFRESH) refresh(context)
  }

  /** A task as the app sends it. */
  data class Item(
    val id: String,
    val title: String,
    val due: String?,
    val start: String?,
    val planned: String?,
    val color: String?,
    val priority: Int,
  )

  /** A task as the widget shows it today. */
  data class Row(val id: String, val title: String, val meta: String, val overdue: Boolean, val color: Int, val priority: Int)

  companion object {
    const val ACTION_OPEN = "app.tasksng.android.widget.OPEN"
    const val ACTION_ADD = "app.tasksng.android.widget.ADD"
    const val ACTION_TODAY = "app.tasksng.android.widget.TODAY"
    const val EXTRA_TASK = "taskId"
    private const val ACTION_REFRESH = "app.tasksng.android.widget.REFRESH"
    private const val PREFS = "tasksng-widget"
    private const val KEY = "items"

    /** Called by the app with the tasks of the coming week (JSON). */
    fun save(context: Context, json: String) {
      val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      if (prefs.getString(KEY, null) == json) return
      prefs.edit().putString(KEY, json).apply()
      refresh(context)
    }

    fun refresh(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      val ids = manager.getAppWidgetIds(ComponentName(context, TodayWidget::class.java))
      if (ids.isEmpty()) return
      for (id in ids) draw(context, manager, id)
      manager.notifyAppWidgetViewDataChanged(ids, R.id.widget_list)
      scheduleMidnight(context)
    }

    private fun items(context: Context): List<Item> {
      val json = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null) ?: return emptyList()
      return runCatching {
        val array = JSONArray(json)
        (0 until array.length()).map { i ->
          val o = array.getJSONObject(i)
          fun text(name: String) = if (o.isNull(name)) null else o.optString(name).ifEmpty { null }
          Item(o.getString("id"), o.optString("title"), text("due"), text("start"), text("planned"), text("color"), o.optInt("priority"))
        }
      }.getOrDefault(emptyList())
    }

    private fun zone(): ZoneId = ZoneId.systemDefault()

    /** `YYYY-MM-DD`, a UTC instant or a floating local time, in local time. */
    private fun parse(value: String?): LocalDateTime? {
      if (value == null) return null
      return runCatching {
        when {
          value.length == 10 -> LocalDate.parse(value).atStartOfDay()
          value.endsWith("Z") -> LocalDateTime.ofInstant(Instant.parse(value), zone())
          else -> LocalDateTime.parse(value)
        }
      }.getOrNull()
    }

    private fun hasTime(value: String?) = value != null && value.length > 10

    private fun parseColor(value: String?): Int =
      value?.let { runCatching { Color.parseColor(it) }.getOrNull() } ?: Color.GRAY

    /** Today's tasks, in the order of the app's Today view: overdue first, then by time and priority. */
    fun rows(context: Context, today: LocalDate = LocalDate.now(zone())): List<Row> {
      val time = DateTimeFormatter.ofPattern("HH:mm")
      val day = DateTimeFormatter.ofPattern("d MMM")
      val out = mutableListOf<Pair<Row, String>>()
      for (item in items(context)) {
        val due = parse(item.due)
        val start = parse(item.start)
        val planned = parse(item.planned)?.takeIf { it.toLocalDate() == today }
        val overdue = due != null && due.toLocalDate().isBefore(today)
        val dueToday = due != null && due.toLocalDate() == today
        val startsToday = start != null && start.toLocalDate() == today
        if (start != null && start.toLocalDate().isAfter(today) && planned == null) continue
        if (!overdue && !dueToday && !startsToday && planned == null) continue
        val meta = when {
          planned != null -> "Planned ${planned.format(time)}"
          overdue -> "Overdue · ${due!!.format(day)}"
          dueToday && hasTime(item.due) -> due!!.format(time)
          dueToday -> "Today"
          else -> "Starts today"
        }
        val sortKey = (if (overdue) "0" else "1") +
          (planned ?: due?.takeIf { hasTime(item.due) } ?: LocalDateTime.of(today, LocalTime.MAX)).toString() +
          (if (item.priority in 1..9) item.priority else 10).toString().padStart(2, '0')
        out += Row(item.id, item.title.ifBlank { "Untitled task" }, meta, overdue && planned == null, parseColor(item.color), item.priority) to sortKey
      }
      return out.sortedBy { it.second }.map { it.first }
    }

    private fun open(context: Context, action: String, code: Int, mutable: Boolean = false): PendingIntent {
      val intent = Intent(context, MainActivity::class.java).setAction(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (mutable) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE)
      return PendingIntent.getActivity(context, code, intent, flags)
    }

    private fun draw(context: Context, manager: AppWidgetManager, id: Int) {
      val views = RemoteViews(context.packageName, R.layout.widget_today)
      val count = rows(context).size
      views.setTextViewText(R.id.widget_count, if (count > 0) count.toString() else "")
      views.setTextViewText(R.id.widget_date, LocalDate.now(zone()).format(DateTimeFormatter.ofPattern("EEE d MMM")))
      val list = Intent(context, TodayWidgetService::class.java)
        .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
      // Tells the system each widget's list apart.
      list.data = Uri.parse(list.toUri(Intent.URI_INTENT_SCHEME))
      @Suppress("DEPRECATION")
      views.setRemoteAdapter(R.id.widget_list, list)
      views.setEmptyView(R.id.widget_list, R.id.widget_empty)
      // Each row fills in which task it is (TodayWidgetService).
      views.setPendingIntentTemplate(R.id.widget_list, open(context, ACTION_OPEN, 1, mutable = true))
      views.setOnClickPendingIntent(R.id.widget_add, open(context, ACTION_ADD, 2))
      views.setOnClickPendingIntent(R.id.widget_header, open(context, ACTION_TODAY, 3))
      manager.updateAppWidget(id, views)
    }

    /** Redraws just after midnight, when other tasks are due. */
    private fun scheduleMidnight(context: Context) {
      val alarms = context.getSystemService(AlarmManager::class.java) ?: return
      val next = ZonedDateTime.now(zone()).toLocalDate().plusDays(1).atStartOfDay(zone()).plusMinutes(1)
      val intent = Intent(context, TodayWidget::class.java).setAction(ACTION_REFRESH)
      val pending = PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      alarms.set(AlarmManager.RTC, next.toInstant().toEpochMilli(), pending)
    }
  }
}
