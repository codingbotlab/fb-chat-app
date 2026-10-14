package com.codingbotlab.fbchat;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.media.RingtoneManager;
import android.os.Build;

import androidx.annotation.NonNull;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;
import java.util.regex.Pattern;

public final class FBChatMessagingService extends FirebaseMessagingService {
    private static final String MESSAGE_CHANNEL_ID = "fbchat_messages";
    private static final String CALLS_CHANNEL_ID = "fbchat_calls";
    private static final Pattern USERNAME = Pattern.compile("^[a-z0-9_.]{3,24}$");

    @Override
    public void onNewToken(@NonNull String token) {
        getSharedPreferences("fbchat_native_push", MODE_PRIVATE)
                .edit().putString("token", token).apply();
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        if (MainActivity.isAppVisible()) return;
        Map<String, String> data = remoteMessage.getData();
        boolean incomingCall = "incoming_call".equals(data.get("type"));
        String caller = data.get("caller_username");
        if (caller != null && !USERNAME.matcher(caller).matches()) caller = null;
        String kind = "video".equals(data.get("call_kind")) ? "video" : "audio";
        String title = safeText(data.get("title"), incomingCall ? "Incoming FB Chat call" : "FB Chat", 80);
        String body = safeText(data.get("body"), incomingCall ? "Incoming call" : "You have a new encrypted message", 140);
        String chatUsername = incomingCall ? caller : data.get("username");
        if (chatUsername != null && !USERNAME.matcher(chatUsername).matches()) chatUsername = null;

        Intent launch = new Intent(this, MainActivity.class);
        launch.setAction("com.codingbotlab.fbchat.OPEN_CHAT");
        launch.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (incomingCall && caller != null) {
            launch.putExtra("callFrom", caller);
            launch.putExtra("callKind", kind);
        } else if (chatUsername != null) {
            launch.putExtra("username", chatUsername);
        }

        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent contentIntent = PendingIntent.getActivity(
                this, (incomingCall ? 0x40000000 : 0) ^ (chatUsername == null ? 0 : chatUsername.hashCode()), launch, pendingFlags);

        String channel = incomingCall ? CALLS_CHANNEL_ID : MESSAGE_CHANNEL_ID;
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, channel)
                : new Notification.Builder(this).setSound(RingtoneManager.getDefaultUri(
                        incomingCall ? RingtoneManager.TYPE_RINGTONE : RingtoneManager.TYPE_NOTIFICATION));
        Notification.Builder configured = builder
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(title)
                .setContentText(body)
                .setCategory(incomingCall ? Notification.CATEGORY_CALL : Notification.CATEGORY_MESSAGE)
                .setVisibility(incomingCall ? Notification.VISIBILITY_PUBLIC : Notification.VISIBILITY_PRIVATE)
                .setAutoCancel(true)
                .setContentIntent(contentIntent);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            configured.setPriority(incomingCall ? Notification.PRIORITY_MAX : Notification.PRIORITY_HIGH)
                    .setVibrate(incomingCall ? new long[]{0, 650, 250, 650} : new long[]{0, 250, 120, 250});
        }
        if (incomingCall && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) configured.setTimeoutAfter(45_000L);
        Notification notification = configured.build();
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify((int) (System.currentTimeMillis() & 0x7fffffff), notification);
    }

    private static String safeText(String value, String fallback, int limit) {
        if (value == null || value.trim().isEmpty()) return fallback;
        String cleaned = value.trim();
        return cleaned.length() > limit ? cleaned.substring(0, limit) : cleaned;
    }
}
