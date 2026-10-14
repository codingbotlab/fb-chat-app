package com.codingbotlab.fbchat;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.SafeBrowsingResponse;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.PermissionRequest;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.ValueCallback;
import android.view.View;
import android.view.Window;
import android.widget.Toast;

import com.google.firebase.messaging.FirebaseMessaging;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

public final class MainActivity extends Activity {
    private static final String APP_URL = "https://chat.fashionbazz.in";
    private static final String APP_HOST = "chat.fashionbazz.in";
    private static final String CHANNEL_ID = "fbchat_messages";
    private static final String CALLS_CHANNEL_ID = "fbchat_calls";
    private static final String PREFS = "fbchat_native_push";
    private static final int NOTIFICATION_PERMISSION_REQUEST = 7102;
    private static final int CALL_PERMISSION_REQUEST = 7103;
    private static final int UPDATE_SOURCE_PERMISSION_REQUEST = 7104;
    private static final int FILE_CHOOSER_REQUEST = 7105;
    private static final String LATEST_RELEASE_API = "https://api.github.com/repos/codingbotlab/fb-chat-app/releases/latest";
    private static final int CHROME = Color.rgb(11, 20, 26);
    private static final Pattern USERNAME = Pattern.compile("^[a-z0-9_.]{3,24}$");
    private static volatile boolean appVisible = false;
    private WebView webView;
    private PermissionRequest pendingWebPermissionRequest;
    private String[] pendingWebPermissionResources = new String[0];
    private ValueCallback<Uri[]> pendingFileChooser;
    private BroadcastReceiver updateDownloadReceiver;
    private long pendingUpdateDownloadId = -1L;
    private String pendingUpdateUrl;
    private Ringtone callRingtone;
    private AudioManager callAudioManager;
    private int previousAudioMode = AudioManager.MODE_NORMAL;
    private boolean previousSpeakerphoneOn;
    private boolean callAudioRouteChanged;

    public static boolean isAppVisible() {
        return appVisible;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window window = getWindow();
        window.setStatusBarColor(CHROME);
        window.setNavigationBarColor(CHROME);
        window.getDecorView().setSystemUiVisibility(0);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setNavigationBarContrastEnforced(false);
            window.setStatusBarContrastEnforced(false);
        }

        createNotificationChannel();
        requestNotificationPermission();
        registerUpdateDownloadReceiver();

        webView = new WebView(this);
        webView.setBackgroundColor(CHROME);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setSupportMultipleWindows(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(true);
        }
        settings.setUserAgentString(settings.getUserAgentString() + " FBChatAndroid/1.1");
        webView.addJavascriptInterface(new NativePushBridge(), "FBChatNative");

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, false);

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> handleWebPermissionRequest(request));
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                if (pendingWebPermissionRequest == request) {
                    pendingWebPermissionRequest = null;
                    pendingWebPermissionResources = new String[0];
                }
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (pendingFileChooser != null) pendingFileChooser.onReceiveValue(null);
                pendingFileChooser = callback;
                Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                picker.addCategory(Intent.CATEGORY_OPENABLE);
                picker.setType("*/*");
                picker.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"image/*", "video/*", "audio/*"});
                if (params != null && params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                    picker.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                }
                try {
                    startActivityForResult(picker, FILE_CHOOSER_REQUEST);
                    return true;
                } catch (ActivityNotFoundException error) {
                    pendingFileChooser = null;
                    callback.onReceiveValue(null);
                    Toast.makeText(MainActivity.this, "No file picker is available on this device.", Toast.LENGTH_LONG).show();
                    return false;
                }
            }
        });
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleNavigation(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleNavigation(Uri.parse(url));
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler,
                                           android.net.http.SslError error) {
                handler.cancel();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request,
                                        WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (request.isForMainFrame()) {
                    Toast.makeText(MainActivity.this,
                            "Connection error. Check your internet and tap Reload.",
                            Toast.LENGTH_LONG).show();
                }
            }
        });

        setContentView(webView);
        String username = notificationUsername(getIntent());
        webView.loadUrl(username == null ? APP_URL : APP_URL + "/?openChat=" + Uri.encode(username));
        refreshFcmToken();
    }


    private void handleWebPermissionRequest(PermissionRequest request) {
        Uri origin = request.getOrigin();
        if (origin == null || !"https".equalsIgnoreCase(origin.getScheme())
                || !APP_HOST.equalsIgnoreCase(origin.getHost())) {
            request.deny();
            return;
        }
        List<String> mediaResources = new ArrayList<>();
        List<String> androidPermissions = new ArrayList<>();
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                mediaResources.add(resource);
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED)
                    androidPermissions.add(Manifest.permission.RECORD_AUDIO);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                        && checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED)
                    androidPermissions.add(Manifest.permission.BLUETOOTH_CONNECT);
            } else if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                mediaResources.add(resource);
                if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED)
                    androidPermissions.add(Manifest.permission.CAMERA);
            }
        }
        if (mediaResources.isEmpty()) {
            request.deny();
            return;
        }
        if (pendingWebPermissionRequest != null && pendingWebPermissionRequest != request) {
            try { pendingWebPermissionRequest.deny(); } catch (RuntimeException ignored) {}
        }
        pendingWebPermissionRequest = request;
        pendingWebPermissionResources = mediaResources.toArray(new String[0]);
        if (androidPermissions.isEmpty()) {
            completePendingWebPermissionRequest();
            return;
        }
        List<String> unique = new ArrayList<>();
        for (String permission : androidPermissions) {
            if (!unique.contains(permission)) unique.add(permission);
        }
        requestPermissions(unique.toArray(new String[0]), CALL_PERMISSION_REQUEST);
    }

    private void completePendingWebPermissionRequest() {
        PermissionRequest request = pendingWebPermissionRequest;
        String[] resources = pendingWebPermissionResources;
        pendingWebPermissionRequest = null;
        pendingWebPermissionResources = new String[0];
        if (request == null) return;
        List<String> granted = new ArrayList<>();
        for (String resource : resources) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)
                    && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                granted.add(resource);
            } else if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)
                    && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                granted.add(resource);
            }
        }
        try {
            if (granted.isEmpty()) request.deny();
            else request.grant(granted.toArray(new String[0]));
        } catch (RuntimeException error) {
            android.util.Log.w("FBChatMedia", "Web media permission request expired", error);
        }
    }

    private boolean hasAndroidPermission(String permission) {
        return checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    private void openAppPermissionSettings() {
        Intent intent = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:" + getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(intent);
    }

    private void registerUpdateDownloadReceiver() {
        updateDownloadReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (!DownloadManager.ACTION_DOWNLOAD_COMPLETE.equals(intent.getAction())) return;
                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L);
                if (id != pendingUpdateDownloadId) return;
                pendingUpdateDownloadId = -1L;
                DownloadManager manager = getSystemService(DownloadManager.class);
                if (manager == null) return;
                Cursor cursor = null;
                try {
                    cursor = manager.query(new DownloadManager.Query().setFilterById(id));
                    if (cursor == null || !cursor.moveToFirst()) {
                        Toast.makeText(MainActivity.this, "Could not verify the downloaded update.", Toast.LENGTH_LONG).show();
                        return;
                    }
                    int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                    if (status != DownloadManager.STATUS_SUCCESSFUL) {
                        int reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
                        android.util.Log.w("FBChatUpdate", "APK download failed, reason=" + reason);
                        Toast.makeText(MainActivity.this, "Update download failed. Check your internet and retry.", Toast.LENGTH_LONG).show();
                        return;
                    }
                    Uri apkUri = manager.getUriForDownloadedFile(id);
                    if (apkUri == null) {
                        Toast.makeText(MainActivity.this, "Downloaded update could not be opened.", Toast.LENGTH_LONG).show();
                        return;
                    }
                    Intent install = new Intent(Intent.ACTION_VIEW);
                    install.setDataAndType(apkUri, "application/vnd.android.package-archive");
                    install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(install);
                } catch (Exception error) {
                    android.util.Log.e("FBChatUpdate", "Could not launch APK installer", error);
                    Toast.makeText(MainActivity.this, "Android could not open the installer. Try downloading the update again.", Toast.LENGTH_LONG).show();
                } finally {
                    if (cursor != null) cursor.close();
                }
            }
        };
        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(updateDownloadReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(updateDownloadReceiver, filter);
        }
    }

    private void beginAppUpdateDownload(String rawUrl) {
        Uri uri = Uri.parse(rawUrl == null ? "" : rawUrl);
        String url = uri.toString();
        if (!"https".equalsIgnoreCase(uri.getScheme())
                || !"github.com".equalsIgnoreCase(uri.getHost())
                || uri.getUserInfo() != null
                || !uri.getPath().startsWith("/codingbotlab/fb-chat-app/releases/download/fbchat-v")
                || !uri.getPath().endsWith(".apk")) {
            Toast.makeText(this, "Update link was rejected for security.", Toast.LENGTH_LONG).show();
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getPackageManager().canRequestPackageInstalls()) {
            pendingUpdateUrl = url;
            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getPackageName()));
            try {
                startActivityForResult(settings, UPDATE_SOURCE_PERMISSION_REQUEST);
                Toast.makeText(this, "Allow installing updates for FB Chat, then return to the app.", Toast.LENGTH_LONG).show();
            } catch (ActivityNotFoundException error) {
                Toast.makeText(this, "Open Android Settings and allow FB Chat to install updates.", Toast.LENGTH_LONG).show();
            }
            return;
        }
        DownloadManager manager = getSystemService(DownloadManager.class);
        if (manager == null) {
            Toast.makeText(this, "Android download service is unavailable.", Toast.LENGTH_LONG).show();
            return;
        }
        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setTitle("FB Chat update");
            request.setDescription("Downloading the signed FB Chat update");
            request.setMimeType("application/vnd.android.package-archive");
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setAllowedOverMetered(true);
            request.setAllowedOverRoaming(false);
            request.setDestinationInExternalFilesDir(this, "Download", "fbchat-update.apk");
            pendingUpdateDownloadId = manager.enqueue(request);
            Toast.makeText(this, "Downloading FB Chat update. Android will ask you to confirm installation.", Toast.LENGTH_LONG).show();
        } catch (Exception error) {
            android.util.Log.e("FBChatUpdate", "Could not enqueue APK download", error);
            Toast.makeText(this, "Could not start update download. Please retry.", Toast.LENGTH_LONG).show();
        }
    }

    private void checkForAppUpdateAsyncBridge() {
        checkForAppUpdate();
    }

    private void checkForAppUpdate() {
        Thread worker = new Thread(() -> {
            HttpURLConnection connection = null;
            JSONObject result = new JSONObject();
            try {
                String currentVersion = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
                connection = (HttpURLConnection) new URL(LATEST_RELEASE_API).openConnection();
                connection.setRequestMethod("GET");
                connection.setConnectTimeout(7000);
                connection.setReadTimeout(7000);
                connection.setUseCaches(false);
                connection.setRequestProperty("Accept", "application/vnd.github+json");
                connection.setRequestProperty("User-Agent", "FBChatAndroid/" + currentVersion);
                if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) {
                    throw new IllegalStateException("Release lookup returned HTTP " + connection.getResponseCode());
                }
                StringBuilder body = new StringBuilder();
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream()))) {
                    String line;
                    while ((line = reader.readLine()) != null) body.append(line);
                }
                JSONObject release = new JSONObject(body.toString());
                String tag = release.optString("tag_name", "");
                String latestVersion = tag.startsWith("fbchat-v") ? tag.substring("fbchat-v".length()) : "";
                String downloadUrl = "";
                org.json.JSONArray assets = release.optJSONArray("assets");
                if (assets != null) {
                    for (int i = 0; i < assets.length(); i++) {
                        JSONObject asset = assets.optJSONObject(i);
                        if (asset == null) continue;
                        if (asset.optString("name", "").equals("fbchat-" + latestVersion + ".apk")) {
                            downloadUrl = asset.optString("browser_download_url", "");
                            break;
                        }
                    }
                }
                result.put("currentVersion", currentVersion == null ? "0" : currentVersion);
                result.put("latestVersion", latestVersion);
                result.put("downloadUrl", downloadUrl);
                result.put("updateAvailable", !latestVersion.isEmpty()
                        && !downloadUrl.isEmpty() && compareVersions(latestVersion, currentVersion) > 0);
            } catch (Exception error) {
                android.util.Log.i("FBChatUpdate", "Update check skipped: " + error.getMessage());
                try { result.put("error", true); } catch (org.json.JSONException ignored) {}
            } finally {
                if (connection != null) connection.disconnect();
            }
            WebView target = webView;
            if (target != null) {
                String json = result.toString();
                runOnUiThread(() -> {
                    if (webView == null) return;
                    webView.evaluateJavascript("window.fbchatOnNativeUpdateCheck && window.fbchatOnNativeUpdateCheck(JSON.parse("
                            + JSONObject.quote(json) + "))", null);
                });
            }
        }, "FBChatUpdateCheck");
        worker.setDaemon(true);
        worker.start();
    }

    private int compareVersions(String left, String right) {
        String[] a = (left == null ? "" : left).split("\\.");
        String[] b = (right == null ? "" : right).split("\\.");
        int length = Math.max(a.length, b.length);
        for (int i = 0; i < length; i++) {
            int av = i < a.length ? parseVersionPart(a[i]) : 0;
            int bv = i < b.length ? parseVersionPart(b[i]) : 0;
            if (av != bv) return Integer.compare(av, bv);
        }
        return 0;
    }

    private int parseVersionPart(String value) {
        try { return Integer.parseInt(value.replaceAll("[^0-9].*$", "")); }
        catch (Exception ignored) { return 0; }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        AudioAttributes notificationAudio = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build();
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "Messages", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("New encrypted FB Chat messages");
        channel.enableVibration(true);
        channel.setVibrationPattern(new long[]{0, 250, 120, 250});
        channel.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION), notificationAudio);
        manager.createNotificationChannel(channel);

        AudioAttributes callAudio = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build();
        NotificationChannel calls = new NotificationChannel(
                CALLS_CHANNEL_ID, "Incoming calls", NotificationManager.IMPORTANCE_HIGH);
        calls.setDescription("Incoming FB Chat voice and video calls");
        calls.enableVibration(true);
        calls.setVibrationPattern(new long[]{0, 650, 250, 650, 250, 650});
        calls.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), callAudio);
        manager.createNotificationChannel(calls);
    }

    private void startCallTone(String kind) {
        runOnUiThread(() -> {
            stopCallToneInternal();
            Uri toneUri = RingtoneManager.getDefaultUri(
                    "incoming".equals(kind) ? RingtoneManager.TYPE_RINGTONE : RingtoneManager.TYPE_NOTIFICATION);
            callRingtone = RingtoneManager.getRingtone(getApplicationContext(), toneUri);
            if (callRingtone == null) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                callRingtone.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage("incoming".equals(kind) ? AudioAttributes.USAGE_NOTIFICATION_RINGTONE : AudioAttributes.USAGE_NOTIFICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) callRingtone.setLooping(true);
            try { callRingtone.play(); } catch (RuntimeException error) {
                android.util.Log.w("FBChatCall", "Could not play call tone", error);
            }
        });
    }

    private void stopCallToneInternal() {
        if (callRingtone != null) {
            try { if (callRingtone.isPlaying()) callRingtone.stop(); } catch (RuntimeException ignored) {}
            callRingtone = null;
        }
    }

    private void stopCallTone() {
        runOnUiThread(this::stopCallToneInternal);
    }

    private void setCallAudioRoute(boolean speaker) {
        runOnUiThread(() -> {
            AudioManager manager = getSystemService(AudioManager.class);
            if (manager == null) return;
            if (!callAudioRouteChanged) {
                callAudioManager = manager;
                previousAudioMode = manager.getMode();
                previousSpeakerphoneOn = manager.isSpeakerphoneOn();
                callAudioRouteChanged = true;
            }
            manager.setMode(AudioManager.MODE_IN_COMMUNICATION);
            manager.setSpeakerphoneOn(speaker);
        });
    }

    private void endCallAudio() {
        runOnUiThread(() -> {
            stopCallToneInternal();
            if (callAudioRouteChanged && callAudioManager != null) {
                try { callAudioManager.setSpeakerphoneOn(previousSpeakerphoneOn); } catch (RuntimeException ignored) {}
                try { callAudioManager.setMode(previousAudioMode); } catch (RuntimeException ignored) {}
            }
            callAudioManager = null;
            callAudioRouteChanged = false;
        });
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},
                    NOTIFICATION_PERMISSION_REQUEST);
        }
    }

    private String notificationUsername(Intent intent) {
        if (intent == null) return null;
        String username = intent.getStringExtra("username");
        if (username == null || !USERNAME.matcher(username).matches()) return null;
        return username;
    }

    private boolean handleNavigation(Uri uri) {
        if (uri == null) return true;
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
        String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase();
        if ("https".equals(scheme) && APP_HOST.equals(host)) return false;
        if ("http".equals(scheme)) {
            Toast.makeText(this, "For security, open links only over HTTPS.", Toast.LENGTH_SHORT).show();
            return true;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException ignored) {
            Toast.makeText(this, "No app can open this link.", Toast.LENGTH_SHORT).show();
        }
        return true;
    }

    private void refreshFcmToken() {
        FirebaseMessaging.getInstance().getToken()
                .addOnSuccessListener(this::saveAndPublishFcmToken)
                .addOnFailureListener(error ->
                        android.util.Log.w("FBChatFCM", "Could not refresh FCM token", error));
    }

    private void saveAndPublishFcmToken(String token) {
        if (token == null || token.trim().isEmpty()) return;
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("token", token).apply();
        WebView target = webView;
        if (target == null) return;
        runOnUiThread(() -> {
            if (webView == null) return;
            String js = "window.fbchatOnFcmToken && window.fbchatOnFcmToken("
                    + JSONObject.quote(token) + ");";
            webView.evaluateJavascript(js, null);
        });
    }

    private void routeNotificationToChat(String username) {
        if (webView == null) return;
        String quoted = JSONObject.quote(username);
        String script = "(function(){if(typeof window.fbchatOpenNativeChat==='function'){"
                + "window.fbchatOpenNativeChat(" + quoted + ");return true;}return false;})()";
        webView.evaluateJavascript(script, value -> {
            if (!"true".equals(value) && webView != null) {
                webView.loadUrl(APP_URL + "/?openChat=" + Uri.encode(username));
            }
        });
    }

    @Override
    protected void onResume() {
        super.onResume();
        appVisible = true;
        refreshFcmToken();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && pendingUpdateUrl != null && getPackageManager().canRequestPackageInstalls()) {
            String url = pendingUpdateUrl;
            pendingUpdateUrl = null;
            beginAppUpdateDownload(url);
        }
    }

    @Override
    protected void onPause() {
        appVisible = false;
        super.onPause();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String username = notificationUsername(intent);
        if (username != null) routeNotificationToChat(username);
        refreshFcmToken();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER_REQUEST && pendingFileChooser != null) {
            Uri[] selected = resultCode == RESULT_OK
                    ? WebChromeClient.FileChooserParams.parseResult(resultCode, data) : null;
            pendingFileChooser.onReceiveValue(selected);
            pendingFileChooser = null;
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == CALL_PERMISSION_REQUEST) completePendingWebPermissionRequest();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        if (webView != null) webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (updateDownloadReceiver != null) {
            try { unregisterReceiver(updateDownloadReceiver); } catch (IllegalArgumentException ignored) {}
            updateDownloadReceiver = null;
        }
        if (pendingFileChooser != null) {
            pendingFileChooser.onReceiveValue(null);
            pendingFileChooser = null;
        }
        if (webView != null) {
            webView.stopLoading();
            webView.removeJavascriptInterface("FBChatNative");
            webView.setWebChromeClient(null);
            webView.setWebViewClient(null);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private final class NativePushBridge {
        @JavascriptInterface
        public String getFcmToken() {
            SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
            return prefs.getString("token", "");
        }

        @JavascriptInterface
        public void refreshToken() {
            runOnUiThread(() -> {
                requestNotificationPermission();
                refreshFcmToken();
            });
        }

        @JavascriptInterface
        public void requestNotificationPermission() {
            runOnUiThread(() -> {
                MainActivity.this.requestNotificationPermission();
                refreshFcmToken();
            });
        }

        @JavascriptInterface
        public String getCallPermissionStatus() {
            JSONObject status = new JSONObject();
            try {
                status.put("microphone", hasAndroidPermission(Manifest.permission.RECORD_AUDIO));
                status.put("camera", hasAndroidPermission(Manifest.permission.CAMERA));
                return status.toString();
            } catch (org.json.JSONException error) {
                return "{}";
            }
        }

        @JavascriptInterface
        public void startCallTone(String kind) {
            MainActivity.this.startCallTone(kind == null ? "ringback" : kind);
        }

        @JavascriptInterface
        public void stopCallTone() {
            MainActivity.this.stopCallTone();
        }

        @JavascriptInterface
        public void setCallAudioRoute(boolean speaker) {
            MainActivity.this.setCallAudioRoute(speaker);
        }

        @JavascriptInterface
        public void endCallAudio() {
            MainActivity.this.endCallAudio();
        }

        @JavascriptInterface
        public void checkForAppUpdate() {
            checkForAppUpdateAsyncBridge();
        }

        @JavascriptInterface
        public void installAppUpdate(String downloadUrl) {
            runOnUiThread(() -> beginAppUpdateDownload(downloadUrl));
        }

        @JavascriptInterface
        public void openAppSettings() {
            runOnUiThread(() -> {
                try { openAppPermissionSettings(); }
                catch (ActivityNotFoundException ignored) {
                    Toast.makeText(MainActivity.this, "Open Android Settings → Apps → FB Chat → Permissions.", Toast.LENGTH_LONG).show();
                }
            });
        }
    }
}
