package com.codingbotlab.fbchat;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.SafeBrowsingResponse;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.view.View;
import android.view.Window;
import android.widget.Toast;

import com.google.firebase.messaging.FirebaseMessaging;

import org.json.JSONObject;

import java.util.regex.Pattern;

public final class MainActivity extends Activity {
    private static final String APP_URL = "https://chat.fashionbazz.in";
    private static final String APP_HOST = "chat.fashionbazz.in";
    private static final String CHANNEL_ID = "fbchat_messages";
    private static final String PREFS = "fbchat_native_push";
    private static final int NOTIFICATION_PERMISSION_REQUEST = 7102;
    private static final int CHROME = Color.rgb(11, 20, 26);
    private static final Pattern USERNAME = Pattern.compile("^[a-z0-9_.]{3,24}$");
    private static volatile boolean appVisible = false;
    private WebView webView;

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

        webView.setWebChromeClient(new WebChromeClient());
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

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "Messages", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("New encrypted FB Chat messages");
        channel.enableVibration(true);
        channel.setVibrationPattern(new long[]{0, 250, 120, 250});
        channel.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
                new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build());
        manager.createNotificationChannel(channel);
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
    }
}
