import "react-native-url-polyfill/auto";
import { registerRootComponent } from "expo";
import * as TaskManager from "expo-task-manager";
import * as Notifications from "expo-notifications";
import { handleResponse } from "./src/notify";
import App from "./App";

// Runs when a notification button (Play / Hold / Later / Discard) is pressed
// while the app is in the background or closed. Android only.
const BG_TASK = "PULL_A_CARD_NOTIFICATION_ACTION";
TaskManager.defineTask(BG_TASK, async ({ data, error }) => {
  if (error || !data || !("actionIdentifier" in data)) return Notifications.BackgroundNotificationTaskResult.NoData;
  try {
    await handleResponse(data);
    return Notifications.BackgroundNotificationTaskResult.NewData;
  } catch {
    return Notifications.BackgroundNotificationTaskResult.Failed;
  }
});
Notifications.registerTaskAsync(BG_TASK).catch(() => {});

registerRootComponent(App);
