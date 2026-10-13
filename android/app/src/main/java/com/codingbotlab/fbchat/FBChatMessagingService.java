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
    private static final String CHANNEL_ID = "fbchat_messages";
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
        String title = safeText(data.get("title"), "FB Chat", 80);
        String body = safeText(data.get("body"), "You have a new encrypted message", 140);
        String username = data.get("username");
        if (username != null && !USERNAME.matcher(username).matches()) username = null;

        Intent launch = new Intent(this, MainActivity.class);
        launch.setAction("com.codingbotlab.fbchat.OPEN_CHAT");
        launch.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (username != null) launch.putExtra("username", username);

        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent contentIntent = PendingIntent.getActivity(
                this, username == null ? 0 : username.hashCode(), launch, pendingFlags);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this)
                    .setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION));
        Notification notification = builder
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(title)
                .setContentText(body)
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setAutoCancel(true)
                .setContentIntent(contentIntent)
                .build();

        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify((int) (System.currentTimeMillis() & 0x7fffffff), notification);
    }

    private static String safeText(String value, String fallback, int limit) {
        if (value == null || value.trim().isEmpty()) return fallback;
        String cleaned = value.trim();
        return cleaned.length() > limit ? cleaned.substring(0, limit) : cleaned;
    }
}
