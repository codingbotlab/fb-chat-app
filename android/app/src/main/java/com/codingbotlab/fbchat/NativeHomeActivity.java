package com.codingbotlab.fbchat;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/**
 * First native UI migration milestone. This screen is built with Android Views,
 * not HTML/WebView. Existing authenticated messaging remains available through
 * MainActivity while chat/conversation screens are migrated incrementally.
 */
public final class NativeHomeActivity extends Activity {
    private static final int CONTACTS_REQUEST = 9101;
    private static final int BG = Color.rgb(11, 20, 26);
    private static final int SURFACE = Color.rgb(31, 45, 52);
    private static final int TEXT = Color.rgb(233, 237, 239);
    private static final int MUTED = Color.rgb(134, 150, 160);
    private static final int GREEN = Color.rgb(0, 168, 132);
    private LinearLayout root;
    private TextView contactsStatus;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);
        getWindow().getDecorView().setSystemUiVisibility(0);
        buildUi();
    }

    private int dp(float value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
    }

    private TextView text(String value, float size, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        view.setGravity(Gravity.CENTER_VERTICAL);
        if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return view;
    }

    private LinearLayout vertical() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        return layout;
    }

    private void buildUi() {
        root = vertical();
        root.setBackgroundColor(BG);
        root.setPadding(dp(20), dp(12), dp(20), dp(10));

        LinearLayout top = new LinearLayout(this);
        top.setGravity(Gravity.CENTER_VERTICAL);
        TextView brand = text("FB Chat", 28, GREEN, true);
        top.addView(brand, new LinearLayout.LayoutParams(0, dp(54), 1));
        TextView more = text("⋮", 30, TEXT, true);
        more.setGravity(Gravity.CENTER);
        top.addView(more, new LinearLayout.LayoutParams(dp(42), dp(48)));
        root.addView(top);

        TextView subtitle = text("Private messaging, made simple", 14, MUTED, false);
        root.addView(subtitle, new LinearLayout.LayoutParams(-1, dp(28)));

        TextView search = text("⌕    Search chats or people", 16, MUTED, false);
        search.setPadding(dp(16), 0, dp(16), 0);
        search.setBackground(roundBackground(SURFACE, 28));
        LinearLayout.LayoutParams searchLp = new LinearLayout.LayoutParams(-1, dp(52));
        searchLp.setMargins(0, dp(18), 0, dp(18));
        root.addView(search, searchLp);

        LinearLayout tabs = new LinearLayout(this);
        tabs.setGravity(Gravity.CENTER_VERTICAL);
        tabs.addView(tab("All", true), new LinearLayout.LayoutParams(0, dp(42), 1));
        tabs.addView(tab("Unread", false), new LinearLayout.LayoutParams(0, dp(42), 1));
        tabs.addView(tab("Groups", false), new LinearLayout.LayoutParams(0, dp(42), 1));
        root.addView(tabs);

        View line = new View(this);
        line.setBackgroundColor(Color.rgb(38, 53, 60));
        LinearLayout.LayoutParams lineLp = new LinearLayout.LayoutParams(-1, dp(1));
        lineLp.setMargins(-dp(20), dp(16), -dp(20), dp(10));
        root.addView(line, lineLp);

        TextView section = text("GET STARTED", 12, MUTED, true);
        section.setLetterSpacing(0.08f);
        LinearLayout.LayoutParams sectionLp = new LinearLayout.LayoutParams(-1, dp(32));
        root.addView(section, sectionLp);

        LinearLayout contactCard = vertical();
        contactCard.setPadding(dp(16), dp(14), dp(16), dp(14));
        contactCard.setBackground(roundBackground(SURFACE, 18));
        TextView contactTitle = text("Find people you know", 17, TEXT, true);
        contactCard.addView(contactTitle, new LinearLayout.LayoutParams(-1, dp(30)));
        contactsStatus = text(hasContactsPermission()
                ? "Contacts permission is enabled on this device."
                : "Allow Contacts access to discover people who use FB Chat.",
                14, MUTED, false);
        contactsStatus.setPadding(0, dp(4), 0, dp(12));
        contactCard.addView(contactsStatus);
        Button contactsButton = button(hasContactsPermission() ? "Open contacts" : "Allow contacts");
        contactsButton.setOnClickListener(v -> {
            if (hasContactsPermission()) openLegacy("contacts");
            else requestPermissions(new String[]{Manifest.permission.READ_CONTACTS}, CONTACTS_REQUEST);
        });
        contactCard.addView(contactsButton, new LinearLayout.LayoutParams(-1, dp(46)));
        LinearLayout.LayoutParams cardLp = new LinearLayout.LayoutParams(-1, -2);
        cardLp.setMargins(0, dp(8), 0, dp(16));
        root.addView(contactCard, cardLp);

        LinearLayout chatCard = vertical();
        chatCard.setPadding(dp(16), dp(14), dp(16), dp(14));
        chatCard.setBackground(roundBackground(SURFACE, 18));
        chatCard.addView(text("Your messages stay private", 17, TEXT, true),
                new LinearLayout.LayoutParams(-1, dp(30)));
        TextView explain = text("Your existing account and encrypted conversations are kept intact while native chat screens are being migrated.", 14, MUTED, false);
        explain.setPadding(0, dp(4), 0, dp(12));
        chatCard.addView(explain);
        Button openChats = button("Continue to chats  →");
        openChats.setOnClickListener(v -> openLegacy(null));
        chatCard.addView(openChats, new LinearLayout.LayoutParams(-1, dp(48)));
        LinearLayout.LayoutParams chatLp = new LinearLayout.LayoutParams(-1, -2);
        chatLp.setMargins(0, 0, 0, dp(14));
        root.addView(chatCard, chatLp);

        TextView migration = text("NATIVE APP • PHASE 1", 11, GREEN, true);
        migration.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams migrationLp = new LinearLayout.LayoutParams(-1, dp(30));
        migrationLp.topMargin = dp(6);
        root.addView(migration, migrationLp);

        TextView note = text("Chats, calls and profile are being moved to native Android screens in stages.", 12, MUTED, false);
        note.setGravity(Gravity.CENTER);
        root.addView(note, new LinearLayout.LayoutParams(-1, dp(42)));

        View spacer = new View(this);
        root.addView(spacer, new LinearLayout.LayoutParams(1, 0, 1));

        LinearLayout nav = new LinearLayout(this);
        nav.setGravity(Gravity.CENTER);
        nav.setBackground(roundBackground(Color.rgb(18, 35, 40), 24));
        nav.addView(navItem("●\nChats", true), new LinearLayout.LayoutParams(0, dp(62), 1));
        nav.addView(navItem("☎\nCalls", false), new LinearLayout.LayoutParams(0, dp(62), 1));
        nav.addView(navItem("♙\nContacts", false), new LinearLayout.LayoutParams(0, dp(62), 1));
        nav.addView(navItem("◉\nProfile", false), new LinearLayout.LayoutParams(0, dp(62), 1));
        root.addView(nav, new LinearLayout.LayoutParams(-1, dp(62)));

        setContentView(root);
    }

    private View tab(String label, boolean selected) {
        TextView view = text(label, 14, selected ? Color.WHITE : MUTED, selected);
        view.setGravity(Gravity.CENTER);
        view.setBackground(roundBackground(selected ? GREEN : SURFACE, 22));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, dp(40));
        lp.setMargins(dp(3), 0, dp(3), 0);
        view.setLayoutParams(lp);
        return view;
    }

    private View navItem(String label, boolean selected) {
        TextView view = text(label, 12, selected ? GREEN : MUTED, selected);
        view.setGravity(Gravity.CENTER);
        view.setOnClickListener(v -> {
            if (label.contains("Contacts")) {
                if (hasContactsPermission()) openLegacy("contacts");
                else requestPermissions(new String[]{Manifest.permission.READ_CONTACTS}, CONTACTS_REQUEST);
            } else if (label.contains("Profile")) openLegacy("profile");
            else if (label.contains("Calls")) openLegacy("calls");
            else openLegacy(null);
        });
        return view;
    }

    private android.graphics.drawable.GradientDrawable roundBackground(int color, int radius) {
        android.graphics.drawable.GradientDrawable shape = new android.graphics.drawable.GradientDrawable();
        shape.setColor(color);
        shape.setCornerRadius(dp(radius));
        return shape;
    }

    private Button button(String label) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextColor(Color.WHITE);
        button.setTextSize(14);
        button.setAllCaps(false);
        button.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        button.setBackground(roundBackground(GREEN, 14));
        if (Build.VERSION.SDK_INT >= 21) button.setElevation(dp(1));
        return button;
    }

    private boolean hasContactsPermission() {
        return checkSelfPermission(Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED;
    }

    private void openLegacy(String section) {
        Intent intent = new Intent(this, MainActivity.class);
        if (section != null) intent.putExtra("openSection", section);
        startActivity(intent);
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == CONTACTS_REQUEST) {
            boolean granted = hasContactsPermission();
            if (contactsStatus != null) contactsStatus.setText(granted
                    ? "Contacts permission is enabled on this device."
                    : "Permission not granted. You can enable it later in Android Settings.");
            Toast.makeText(this, granted ? "Contacts permission granted" : "Contacts permission not granted",
                    Toast.LENGTH_SHORT).show();
            if (granted) openLegacy("contacts");
        }
    }
}
