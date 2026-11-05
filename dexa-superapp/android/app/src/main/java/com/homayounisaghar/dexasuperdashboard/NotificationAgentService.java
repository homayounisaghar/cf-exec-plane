package com.homayounisaghar.dexasuperdashboard;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.util.Log;
/** Future-capable listener: opted in from system settings; records no notification content. */
public final class NotificationAgentService extends NotificationListenerService {
    @Override public void onListenerConnected() {super.onListenerConnected();Log.i("DexaNotification","LISTENER_CONNECTED");}
    @Override public void onNotificationPosted(StatusBarNotification sbn) {
        // No automatic logging, upload, recording, or processing of notification content.
    }
    @Override public void onNotificationRemoved(StatusBarNotification sbn) {}
}
