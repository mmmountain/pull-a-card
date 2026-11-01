package expo.modules.takeover

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
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/** The full-screen card. Shows over other apps and the lock screen, rings until you choose. */
class TakeoverActivity : Activity() {
  private var ring: Ringtone? = null
  private var id: String = ""

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
      setPadding(dp(28), dp(48), dp(28), dp(48))
    }
    val card = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER
      background = GradientDrawable().apply { setColor(Color.parseColor("#FFFDF7")); cornerRadius = dp(22).toFloat() }
      setPadding(dp(24), dp(56), dp(24), dp(56))
      elevation = dp(10).toFloat()
    }
    card.addView(TextView(this).apply {
      text = title; setTextColor(Color.parseColor("#3A1630")); textSize = 42f
      typeface = Typeface.DEFAULT_BOLD; gravity = Gravity.CENTER
    })
    if (body.isNotEmpty()) card.addView(TextView(this).apply {
      text = body; setTextColor(Color.parseColor("#8A4F6C")); textSize = 17f; gravity = Gravity.CENTER
      setPadding(0, dp(14), 0, 0)
    })
    root.addView(card, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))

    fun button(label: String, filled: Boolean, onTap: () -> Unit) = Button(this).apply {
      text = label; isAllCaps = false; textSize = 18f
      setTextColor(Color.parseColor(if (filled) "#3A1630" else "#FFFFFF"))
      background = GradientDrawable().apply {
        cornerRadius = dp(14).toFloat()
        if (filled) setColor(Color.parseColor("#FFF3A6")) else { setColor(Color.TRANSPARENT); setStroke(dp(2), Color.WHITE) }
      }
      setOnClickListener { onTap() }
    }
    val lp = { LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(58)).apply { topMargin = dp(14) } }
    root.addView(button("Open the card", true) {
      TakeoverCore.cancel(this, id)
      packageManager.getLaunchIntentForPackage(packageName)?.let { startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
      finish()
    }, lp().apply { topMargin = dp(28) })
    root.addView(button("5 more minutes", false) {
      TakeoverCore.snooze(this, id, 5)
      finish()
    }, lp())
    setContentView(root)

    ring = RingtoneManager.getRingtone(this, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM))?.apply {
      audioAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build()
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) isLooping = true
      try { play() } catch (_: Exception) {}
    }
  }

  override fun onDestroy() { ring?.stop(); super.onDestroy() }
  @Deprecated("Back keeps the takeover up; choose a button.")
  override fun onBackPressed() { /* stay up */ }
}
