package com.codingbotlab.fbchat;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class NativeHomeActivity extends Activity {
    private static final int BG=Color.rgb(11,20,26), SURFACE=Color.rgb(31,45,52),
            TEXT=Color.rgb(233,237,239), MUTED=Color.rgb(134,150,160), GREEN=Color.rgb(0,168,132);
    private static final String PREFS="fbchat_native_session";
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private final Handler main=new Handler(Looper.getMainLooper());
    private LinearLayout root, body;
    private EditText emailInput, passwordInput;
    private TextView status;
    private NativeApi.Session session;
    private JSONObject me;
    private boolean busy=false;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(BG); getWindow().setNavigationBarColor(BG);
        getWindow().getDecorView().setSystemUiVisibility(0);
        SharedPreferences p=getSharedPreferences(PREFS,MODE_PRIVATE);
        String access=p.getString("access",""), refresh=p.getString("refresh","");
        if(!access.isEmpty()&&!refresh.isEmpty()) {
            session=new NativeApi.Session(access,refresh,p.getString("email",""),p.getString("uid",""));
            loadAccount();
        } else showLogin();
    }
    private int dp(float v){return (int)(v*getResources().getDisplayMetrics().density+.5f);}
    private GradientDrawable shape(int color,int radius){
        GradientDrawable d=new GradientDrawable(); d.setColor(color); d.setCornerRadius(dp(radius)); return d;
    }
    private TextView text(String value,int size,int color,boolean bold){
        TextView t=new TextView(this); t.setText(value); t.setTextSize(size); t.setTextColor(color);
        t.setGravity(Gravity.CENTER_VERTICAL); if(bold)t.setTypeface(Typeface.DEFAULT,Typeface.BOLD); return t;
    }
    private LinearLayout vertical(){LinearLayout l=new LinearLayout(this);l.setOrientation(LinearLayout.VERTICAL);return l;}
    private Button button(String label){
        Button b=new Button(this);b.setText(label);b.setTextColor(Color.WHITE);b.setTextSize(15);b.setAllCaps(false);
        b.setTypeface(Typeface.DEFAULT,Typeface.BOLD);b.setBackground(shape(GREEN,14));return b;
    }
    private EditText field(String hint,int type){
        EditText e=new EditText(this);e.setSingleLine(true);e.setTextSize(16);e.setTextColor(TEXT);
        e.setHintTextColor(MUTED);e.setHint(hint);e.setInputType(type);e.setPadding(dp(16),0,dp(16),0);
        e.setBackground(shape(SURFACE,14));return e;
    }
    private void base(String subtitle){
        root=vertical();root.setBackgroundColor(BG);root.setPadding(dp(20),dp(12),dp(20),dp(14));
        LinearLayout top=new LinearLayout(this);top.setGravity(Gravity.CENTER_VERTICAL);
        top.addView(text("FB Chat",28,GREEN,true),new LinearLayout.LayoutParams(0,dp(58),1));
        root.addView(top);
        root.addView(text(subtitle,14,MUTED,false),new LinearLayout.LayoutParams(-1,dp(30)));
        ScrollView scroll=new ScrollView(this);scroll.setFillViewport(true);
        body=vertical();body.setPadding(0,dp(18),0,dp(12));scroll.addView(body);
        root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
        status=text("",13,Color.rgb(255,170,120),false);root.addView(status,new LinearLayout.LayoutParams(-1,dp(42)));
        setContentView(root);
    }
    private void showLogin(){
        base("Private messaging, made simple");
        TextView title=text("Welcome back",25,TEXT,true);
        body.addView(title,new LinearLayout.LayoutParams(-1,dp(48)));
        TextView help=text("Sign in to your existing FB Chat account.",15,MUTED,false);
        body.addView(help,new LinearLayout.LayoutParams(-1,dp(48)));
        emailInput=field("Email address",InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        LinearLayout.LayoutParams fp=new LinearLayout.LayoutParams(-1,dp(56));fp.topMargin=dp(18);body.addView(emailInput,fp);
        passwordInput=field("Password",InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_PASSWORD);
        fp=new LinearLayout.LayoutParams(-1,dp(56));fp.topMargin=dp(12);body.addView(passwordInput,fp);
        Button login=button("Sign in securely");
        fp=new LinearLayout.LayoutParams(-1,dp(54));fp.topMargin=dp(20);body.addView(login,fp);
        login.setOnClickListener(v->doLogin());
        passwordInput.setOnEditorActionListener((v,action,event)->{if(action==EditorInfo.IME_ACTION_DONE){doLogin();return true;}return false;});
        TextView foot=text("Native Android sign-in • HTTPS connection",12,MUTED,false);
        foot.setGravity(Gravity.CENTER);fp=new LinearLayout.LayoutParams(-1,dp(48));fp.topMargin=dp(12);body.addView(foot,fp);
        status.setText("Existing account required. New-account encryption setup is not migrated yet.");
    }
    private void doLogin(){
        if(busy)return;
        String email=emailInput.getText().toString().trim(), password=passwordInput.getText().toString();
        if(email.isEmpty()||password.isEmpty()){status.setText("Enter your email and password.");return;}
        busy=true;status.setText("Signing in securely…");
        worker.execute(()->{
            try{
                NativeApi.Session s=NativeApi.login(email,password);
                JSONObject account=NativeApi.me(s);
                main.post(()->{
                    session=s;me=account;saveSession();busy=false;showChats();
                });
            }catch(Exception e){main.post(()->{busy=false;status.setText(e.getMessage()==null?"Sign-in failed.":e.getMessage());});}
        });
    }
    private void saveSession(){
        getSharedPreferences(PREFS,MODE_PRIVATE).edit().putString("access",session.accessToken)
                .putString("refresh",session.refreshToken).putString("email",session.email)
                .putString("uid",session.userId).apply();
    }
    private void loadAccount(){
        base("Your messages");
        status.setText("Loading your secure account…");
        worker.execute(()->{
            try{JSONObject a=NativeApi.me(session);JSONArray c=NativeApi.chats(session);
                main.post(()->{me=a;showChats(c);});
            }catch(Exception e){main.post(()->{
                getSharedPreferences(PREFS,MODE_PRIVATE).edit().clear().apply();session=null;showLogin();
                status.setText("Session expired. Please sign in again.");
            });}
        });
    }
    private void showChats(){worker.execute(()->{
        try{JSONArray c=NativeApi.chats(session);main.post(()->showChats(c));}
        catch(Exception e){main.post(()->status.setText("Could not load chats: "+e.getMessage()));}
    });}
    private void showChats(JSONArray chats){
        base("Your account • Native Android");
        JSONObject profile=me==null?new JSONObject():me.optJSONObject("profile");
        String display=profile==null?"":profile.optString("display_name","");
        String username=profile==null?"":profile.optString("username","");
        LinearLayout card=vertical();card.setPadding(dp(16),dp(14),dp(16),dp(14));card.setBackground(shape(SURFACE,18));
        card.addView(text(display.isEmpty()?"Your account":display,19,TEXT,true),new LinearLayout.LayoutParams(-1,dp(34)));
        card.addView(text(username.isEmpty()?"":("@"+username),14,MUTED,false),new LinearLayout.LayoutParams(-1,dp(28)));
        body.addView(card,new LinearLayout.LayoutParams(-1,-2));
        LinearLayout heading=new LinearLayout(this);heading.setGravity(Gravity.CENTER_VERTICAL);
        heading.addView(text("Chats",21,TEXT,true),new LinearLayout.LayoutParams(0,dp(58),1));
        Button refresh=button("New chat");heading.addView(refresh,new LinearLayout.LayoutParams(dp(108),dp(42)));
        refresh.setOnClickListener(v->{EditText input=field("Username",InputType.TYPE_CLASS_TEXT);new android.app.AlertDialog.Builder(this).setTitle("Start a new chat").setMessage("Enter the exact FB Chat username.").setView(input).setNegativeButton("Cancel",null).setPositiveButton("Open",(dialog,which)->{String handle=input.getText().toString().trim().replace("@","");if(handle.isEmpty()){status.setText("Enter a username.");return;}Intent intent=new Intent(this,NativeConversationActivity.class);intent.putExtra("username",handle);intent.putExtra("displayName","@"+handle);startActivity(intent);}).show();});body.addView(heading);
        if(chats==null||chats.length()==0){
            TextView empty=text("No conversations yet. Your chat list will appear here when you start messaging.",15,MUTED,false);
            empty.setGravity(Gravity.CENTER);empty.setPadding(dp(12),dp(24),dp(12),dp(24));
            body.addView(empty,new LinearLayout.LayoutParams(-1,dp(140)));
        } else {
            for(int i=0;i<chats.length();i++){
                JSONObject item=chats.optJSONObject(i);if(item==null)continue;
                JSONObject peer=item.optJSONObject("peer");if(peer==null)continue;
                String name=peer.optString("display_name",peer.optString("username","FB Chat user"));
                String handle="@"+peer.optString("username","");
                LinearLayout row=new LinearLayout(this);row.setGravity(Gravity.CENTER_VERTICAL);row.setPadding(dp(12),dp(8),dp(12),dp(8));
                row.setBackground(shape(SURFACE,16));
                TextView avatar=text(name.isEmpty()?"?":name.substring(0,1).toUpperCase(),21,Color.WHITE,true);
                avatar.setGravity(Gravity.CENTER);avatar.setBackground(shape(GREEN,32));
                row.addView(avatar,new LinearLayout.LayoutParams(dp(48),dp(48)));
                LinearLayout labels=vertical();labels.setPadding(dp(12),0,0,0);
                labels.addView(text(name,16,TEXT,true),new LinearLayout.LayoutParams(-1,dp(28)));
                labels.addView(text(handle,13,MUTED,false),new LinearLayout.LayoutParams(-1,dp(24)));
                row.addView(labels,new LinearLayout.LayoutParams(0,dp(58),1));
                LinearLayout.LayoutParams rp=new LinearLayout.LayoutParams(-1,dp(74));rp.bottomMargin=dp(8);body.addView(row,rp);
                row.setOnClickListener(v->{Intent intent=new Intent(this,NativeConversationActivity.class);intent.putExtra("username",peer.optString("username",""));intent.putExtra("displayName",name);startActivity(intent);});
            }
        }
        LinearLayout actions=new LinearLayout(this);actions.setGravity(Gravity.CENTER_VERTICAL);
        Button contacts=button("Contacts");Button profileButton=button("Profile");
        LinearLayout.LayoutParams ap=new LinearLayout.LayoutParams(0,dp(48),1);ap.rightMargin=dp(8);actions.addView(contacts,ap);
        actions.addView(profileButton,new LinearLayout.LayoutParams(0,dp(48),1));
        contacts.setOnClickListener(v->requestContacts());
        profileButton.setOnClickListener(v->showProfile());
        LinearLayout.LayoutParams actionLp=new LinearLayout.LayoutParams(-1,dp(52));actionLp.topMargin=dp(12);body.addView(actions,actionLp);
        Button signOut=button("Sign out");LinearLayout.LayoutParams so=new LinearLayout.LayoutParams(-1,dp(48));so.topMargin=dp(8);body.addView(signOut,so);
        signOut.setOnClickListener(v->{session=null;me=null;getSharedPreferences(PREFS,MODE_PRIVATE).edit().clear().apply();showLogin();});
        status.setText("Native chat list and encrypted messaging are available. More native features are being migrated.");
    }
    private void showProfile(){
        base("Profile & settings");
        JSONObject p=me==null?null:me.optJSONObject("profile");
        body.addView(text(p==null?"Your profile":p.optString("display_name","Your profile"),24,TEXT,true),new LinearLayout.LayoutParams(-1,dp(56)));
        body.addView(text(p==null?"":("@"+p.optString("username","")),15,MUTED,false),new LinearLayout.LayoutParams(-1,dp(38)));
        body.addView(text("Account: "+session.email,14,MUTED,false),new LinearLayout.LayoutParams(-1,dp(44)));
        body.addView(text("Encryption keys are protected with Android Keystore on this device. Native profile editing, photo updates and contact matching are still being migrated.",14,TEXT,false),new LinearLayout.LayoutParams(-1,dp(96)));
        Button back=button("Back to chats");body.addView(back,new LinearLayout.LayoutParams(-1,dp(50)));back.setOnClickListener(v->showChats());
    }
    private void requestContacts(){
        if(checkSelfPermission(Manifest.permission.READ_CONTACTS)==PackageManager.PERMISSION_GRANTED){
            Toast.makeText(this,"Contacts permission is enabled. Native contact matching is next.",Toast.LENGTH_LONG).show();
        }else requestPermissions(new String[]{Manifest.permission.READ_CONTACTS},9101);
    }
    @Override protected void onDestroy(){worker.shutdownNow();super.onDestroy();}
}
