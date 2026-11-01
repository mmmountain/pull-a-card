package expo.modules.takeover

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class TakeoverReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val id = intent.getStringExtra("id") ?: return
    TakeoverCore.fire(context, id)
  }
}
