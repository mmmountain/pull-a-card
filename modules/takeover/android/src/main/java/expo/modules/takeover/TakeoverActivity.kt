package expo.modules.takeover

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.AudioAttributes
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Build
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.abs
import kotlin.math.hypot

/**
 * The full-screen card. Shows over other apps and the lock screen and rings until you act.
 * Swipe the card like in the app (↑ play, ↓ hold, ← less often, → snooze 30 min) or use the buttons.
 * Lock alarms ("you're holding 5"): ↑ play one, ← discard one, ↓ or → 5 more minutes.
 */
class TakeoverActivity : Activity() {
  private var ring: Ringtone? = null
  private var id: String = ""
  private val kind get() = when {
    id == "test" -> "test"
    id.startsWith("lock-") -> "lock"
    else -> "card"
  }

  @SuppressLint("ClickableViewAccessibility")
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) { setShowWhenLocked(true); setTurnScreenOn(true) }
    else @Suppress("DEPRECATION") window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    id = intent.getStringExtra("id") ?: ""
    val d = TakeoverCore.data(this, id)
    val title = d?.optString("title") ?: "Time"
    val body = d?.optString("body") ?: ""
    TakeoverCore.clearNotification(this, id)

    val dp = { v: Int -> TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt() }
    val root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER
      setBackgroundColor(Color.parseColor("#FF4F86"))
      setPadding(dp(28), dp(40), dp(28), dp(40))
      clipChildren = false
    }
    val hint = TextView(this).apply {
      setTextColor(Color.WHITE); textSize = 15f; gravity = Gravity.CENTER
      text = when (kind) {
        "lock" -> "↑ play one   ← discard one   → 5 min"
        "test" -> "Swipe the card or tap Stop"
        else -> "↑ play   ↓ hold   ← less often   → snooze 30 min"
      }
      setPadding(0, 0, 0, dp(14))
    }
    root.addView(hint)
    val card = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER
      background = GradientDrawable().apply { setColor(Color.parseColor("#FFFDF7")); cornerRadius = dp(22).toFloat() }
      setPadding(dp(24), dp(72), dp(24), dp(72))
      elevation = dp(10).toFloat()
    }
    card.addView(TextView(this).apply {
      text = title; setTextColor(Color.parseColor("#3A1630")); textSize = 40f
      typeface = Typeface.DEFAULT_BOLD; gravity = Gravity.CENTER
    })
    if (body.isNotEmpty()) card.addView(TextView(this).apply {
      text = body; setTextColor(Color.parseColor("#8A4F6C")); textSize = 17f; gravity = Gravity.CENTER
      setPadding(0, dp(14), 0, 0)
    })
    root.addView(card, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))

    // Swipe the card.
    val far = dp(90).toFloat()
    fun dir(dx: Float, dy: Float): String? {
      if (hypot(dx, dy) < far) return null
      return if (abs(dy) > abs(dx)) (if (dy < 0) "play" else "hold") else (if (dx < 0) "less" else "snooze")
    }
    fun label(a: String?) = when (kind to a) {
      "lock" to "play" -> "Play one"; "lock" to "less" -> "Discard one"; "lock" to "hold", "lock" to "snooze" -> "5 more minutes"
      else -> when (a) { "play" -> "Play"; "hold" -> "Hold"; "less" -> "Less often"; "snooze" -> "Snooze 30 min"; else -> null }
    }
    val idle = hint.text
    var x0 = 0f; var y0 = 0f
    card.setOnTouchListener { v, e ->
      when (e.actionMasked) {
        MotionEvent.ACTION_DOWN -> { x0 = e.rawX; y0 = e.rawY; true }
        MotionEvent.ACTION_MOVE -> {
          val dx = e.rawX - x0; val dy = e.rawY - y0
          v.translationX = dx; v.translationY = dy; v.rotation = dx / 25f
          hint.text = label(dir(dx, dy)) ?: idle
          true
        }
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
          val dx = e.rawX - x0; val dy = e.rawY - y0
          val a = if (e.actionMasked == MotionEvent.ACTION_UP) dir(dx, dy) else null
          if (a == null) { hint.text = idle; v.animate().translationX(0f).translationY(0f).rotation(0f).setDuration(180).start() }
          else v.animate().translationX(dx * 5).translationY(dy * 5).alpha(0f).setDuration(200).withEndAction { choose(a) }.start()
          true
        }
        else -> false
      }
    }

    fun button(label: String, filled: Boolean, onTap: () -> Unit) = Button(this).apply {
      text = label; isAllCaps = false; textSize = 18f
      setTextColor(Color.parseColor(if (filled) "#3A1630" else "#FFFFFF"))
      background = GradientDrawable().apply {
        cornerRadius = dp(14).toFloat()
        if (filled) setColor(Color.parseColor("#FFF3A6")) else { setColor(Color.TRANSPARENT); setStroke(dp(2), Color.WHITE) }
      }
      setOnClickListener { onTap() }
    }
    val lp = { LinearLayout.LayoutParams(0, dp(56), 1f).apply { marginStart = dp(5); marginEnd = dp(5) } }
    val row = { LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL } }
    if (kind == "test") {
      root.addView(button("Stop the test", true) { choose("stop") }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(56)).apply { topMargin = dp(28) })
    } else {
      val r1 = row()
      r1.addView(button(if (kind == "lock") "Play one" else "Play", true) { choose("play") }, lp())
      r1.addView(button(if (kind == "lock") "Discard one" else "Hold", false) { choose(if (kind == "lock") "less" else "hold") }, lp())
      root.addView(r1, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(28) })
      val r2 = row()
      r2.addView(button("5 more minutes", false) { choose("snooze5") }, lp())
      r2.addView(button("Open the app", false) { choose("open") }, lp())
      root.addView(r2, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(12) })
    }
    setContentView(root)

    ring = RingtoneManager.getRingtone(this, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM))?.apply {
      audioAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build()
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) isLooping = true
      try { play() } catch (_: Exception) {}
    }
  }

  private fun choose(action: String) {
    when {
      kind == "test" -> TakeoverCore.cancel(this, id)
      action == "snooze5" || (kind == "lock" && (action == "hold" || action == "snooze")) -> TakeoverCore.snooze(this, id, 5)
      action == "open" -> {
        TakeoverCore.cancel(this, id)
        getSharedPreferences("pullacard_takeover_open", MODE_PRIVATE).edit().putBoolean("showCard", true).apply()
        packageManager.getLaunchIntentForPackage(packageName)?.let { startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
      }
      else -> {
        TakeoverCore.cancel(this, id)
        TakeoverCore.queueAction(this, id, action)
        TakeoverModule.ping()
      }
    }
    finish()
  }

  override fun onDestroy() { ring?.stop(); super.onDestroy() }
  @Deprecated("Back keeps the takeover up; choose a button.")
  override fun onBackPressed() { /* stay up */ }
}
