package expo.modules.takeover

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import androidx.core.app.NotificationCompat
import org.json.JSONObject

/** Schedules, fires and cancels takeover alarms. State lives in SharedPreferences so it survives the app closing. */
object TakeoverCore {
  private const val CHANNEL = "takeover_v1"
  private const val PREFS = "pullacard_takeover"

  private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
  private fun code(id: String) = 7000 + (id.hashCode() and 0x0fffffff) % 100000

  fun ensureChannel(ctx: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = ctx.getSystemService(NotificationManager::class.java)
    if (nm.getNotificationChannel(CHANNEL) != null) return
    val ch = NotificationChannel(CHANNEL, "Takeover alarms", NotificationManager.IMPORTANCE_HIGH)
    ch.description = "Full-screen alarms for cards like Go to bed"
    ch.setSound(
      RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM),
      AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
    )
    ch.enableVibration(true)
    ch.vibrationPattern = longArrayOf(0, 700, 400, 700, 400, 700)
    ch.lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
    ch.setBypassDnd(true)
    nm.createNotificationChannel(ch)
  }

  fun schedule(ctx: Context, id: String, at: Long, title: String, body: String, repeatMins: Int, repeats: Int) {
    val data = JSONObject().put("title", title).put("body", body).put("repeatMins", repeatMins).put("left", repeats).put("at", at)
    prefs(ctx).edit().putString(id, data.toString()).apply()
    setAlarm(ctx, id, at)
  }

  private fun firePending(ctx: Context, id: String): PendingIntent =
    PendingIntent.getBroadcast(
      ctx, code(id),
      Intent(ctx, TakeoverReceiver::class.java).setAction("expo.modules.takeover.FIRE").putExtra("id", id),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

  fun screenPending(ctx: Context, id: String): PendingIntent =
    PendingIntent.getActivity(
      ctx, code(id),
      Intent(ctx, TakeoverActivity::class.java).putExtra("id", id)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

  private fun setAlarm(ctx: Context, id: String, at: Long) {
    val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    val pi = firePending(ctx, id)
    val exact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms()
    if (exact) am.setAlarmClock(AlarmManager.AlarmClockInfo(at, screenPending(ctx, id)), pi)
    else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
  }

  fun data(ctx: Context, id: String): JSONObject? = prefs(ctx).getString(id, null)?.let { JSONObject(it) }

  /** The alarm went off: show the full-screen card and line up the next nag. */
  fun fire(ctx: Context, id: String) {
    val d = data(ctx, id) ?: return
    ensureChannel(ctx)
    val n = NotificationCompat.Builder(ctx, CHANNEL)
      .setSmallIcon(ctx.applicationInfo.icon)
      .setContentTitle(d.optString("title"))
      .setContentText(d.optString("body"))
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setCategory(NotificationCompat.CATEGORY_ALARM)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setOngoing(true)
      .setAutoCancel(false)
      .setFullScreenIntent(screenPending(ctx, id), true)
      .setContentIntent(screenPending(ctx, id))
      .build()
    n.flags = n.flags or android.app.Notification.FLAG_INSISTENT
    try { ctx.getSystemService(NotificationManager::class.java).notify(code(id), n) } catch (_: SecurityException) {}
    // With "Display over other apps" allowed, take over the screen even while the phone is in use
    // (otherwise Android only shows a banner when the screen is on).
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M || android.provider.Settings.canDrawOverlays(ctx)) {
      try { ctx.startActivity(Intent(ctx, TakeoverActivity::class.java).putExtra("id", id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: Exception) {}
    }
    val left = d.optInt("left", 0)
    val every = d.optInt("repeatMins", 0)
    if (left > 0 && every > 0) {
      d.put("left", left - 1)
      prefs(ctx).edit().putString(id, d.toString()).apply()
      setAlarm(ctx, id, System.currentTimeMillis() + every * 60_000L)
    }
  }

  fun snooze(ctx: Context, id: String, mins: Int) {
    clearNotification(ctx, id)
    data(ctx, id) ?: return
    setAlarm(ctx, id, System.currentTimeMillis() + mins * 60_000L)
  }

  fun clearNotification(ctx: Context, id: String) {
    ctx.getSystemService(NotificationManager::class.java).cancel(code(id))
  }

  fun cancel(ctx: Context, id: String) {
    val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    am.cancel(firePending(ctx, id))
    clearNotification(ctx, id)
    prefs(ctx).edit().remove(id).apply()
  }

  fun ids(ctx: Context): List<String> = prefs(ctx).all.keys.toList()
}
