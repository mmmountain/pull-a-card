package expo.modules.takeover

import android.app.NotificationManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class TakeoverModule : Module() {
  private val ctx get() = appContext.reactContext ?: throw IllegalStateException("No Android context")

  override fun definition() = ModuleDefinition {
    Name("Takeover")

    Function("schedule") { id: String, at: Double, title: String, body: String, repeatMins: Int, repeats: Int ->
      TakeoverCore.schedule(ctx, id, at.toLong(), title, body, repeatMins, repeats)
    }
    Function("cancel") { id: String -> TakeoverCore.cancel(ctx, id) }
    Function("cancelAll") { TakeoverCore.ids(ctx).forEach { TakeoverCore.cancel(ctx, it) } }
    Function("ids") { TakeoverCore.ids(ctx) }
    Function("showNow") { title: String, body: String ->
      TakeoverCore.schedule(ctx, "test", System.currentTimeMillis() + 3000, title, body, 0, 0)
    }
    Function("canFullScreen") {
      if (Build.VERSION.SDK_INT >= 34) ctx.getSystemService(NotificationManager::class.java).canUseFullScreenIntent() else true
    }
    Function("openFullScreenSettings") {
      val intent = if (Build.VERSION.SDK_INT >= 34)
        Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + ctx.packageName))
      else Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName)
      ctx.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
  }
}
