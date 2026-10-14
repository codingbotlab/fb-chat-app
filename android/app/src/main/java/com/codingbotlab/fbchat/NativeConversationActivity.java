package com.codingbotlab.fbchat;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.inputmethod.InputMethodManager;
import android.content.Context;
import android.widget.*;
import org.json.JSONObject;
import org.json.JSONArray;
import io.socket.client.IO;
import io.socket.client.Socket;
import io.socket.client.Ack;
import java.net.URISyntaxException;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class NativeConversationActivity extends Activity {
    private static final int BG=Color.rgb(11,20,26), SURFACE=Color.rgb(31,45,52),
        TEXT=Color.rgb(233,237,239), MUTED=Color.rgb(134,150,160), GREEN=Color.rgb(0,168,132);
    private final Handler main=new Handler(Looper.getMainLooper());
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private NativeApi.Session session;
    private JSONObject me, profile, privateKey, peer;
    private Socket socket;
    private LinearLayout root, messages;
    private EditText composer;
    private TextView status;
    private String username="", displayName="";
    private boolean ready=false;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(BG); getWindow().setNavigationBarColor(BG);
        username=getIntent().getStringExtra("username");
        displayName=getIntent().getStringExtra("displayName");
        if(username==null || username.trim().isEmpty()){finish();return;}
        android.content.SharedPreferences pref=getSharedPreferences("fbchat_native_session",MODE_PRIVATE);
        String a=pref.getString("access",""), r=pref.getString("refresh","");
        if(a.isEmpty()||r.isEmpty()){finish();return;}
        session=new NativeApi.Session(a,r,pref.getString("email",""),pref.getString("uid",""));
        buildUi();
        unlockAndConnect();
    }
    private int dp(float n){return (int)(n*getResources().getDisplayMetrics().density+.5f);}
    private GradientDrawable shape(int color,int radius){
        GradientDrawable d=new GradientDrawable();d.setColor(color);d.setCornerRadius(dp(radius));return d;
    }
    private TextView label(String s,int size,int color,boolean bold){
        TextView t=new TextView(this);t.setText(s);t.setTextSize(size);t.setTextColor(color);
        if(bold)t.setTypeface(Typeface.DEFAULT,Typeface.BOLD);return t;
    }
    private void buildUi(){
        root=new LinearLayout(this);root.setOrientation(LinearLayout.VERTICAL);root.setBackgroundColor(BG);
        LinearLayout header=new LinearLayout(this);header.setGravity(Gravity.CENTER_VERTICAL);header.setPadding(dp(12),dp(8),dp(12),dp(8));
        TextView back=label("‹",34,GREEN,true);header.addView(back,new LinearLayout.LayoutParams(dp(40),dp(48)));back.setOnClickListener(v->finish());
        LinearLayout names=new LinearLayout(this);names.setOrientation(LinearLayout.VERTICAL);
        names.addView(label(displayName==null||displayName.isEmpty()?("@"+username):displayName,17,TEXT,true));
        status=label("Connecting securely…",12,MUTED,false);names.addView(status);
        header.addView(names,new LinearLayout.LayoutParams(0,-2,1));root.addView(header);
        ScrollView scroll=new ScrollView(this);scroll.setFillViewport(true);
        messages=new LinearLayout(this);messages.setOrientation(LinearLayout.VERTICAL);messages.setPadding(dp(12),dp(12),dp(12),dp(12));
        scroll.addView(messages);root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
        LinearLayout sendBar=new LinearLayout(this);sendBar.setGravity(Gravity.CENTER_VERTICAL);sendBar.setPadding(dp(8),dp(8),dp(8),dp(8));
        composer=new EditText(this);composer.setSingleLine(true);composer.setTextColor(TEXT);composer.setHintTextColor(MUTED);
        composer.setHint("Message");composer.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        composer.setBackground(shape(SURFACE,24));composer.setPadding(dp(16),0,dp(16),0);
        sendBar.addView(composer,new LinearLayout.LayoutParams(0,dp(48),1));
        Button send=new Button(this);send.setText("➤");send.setTextColor(Color.WHITE);send.setBackground(shape(GREEN,24));
        LinearLayout.LayoutParams sp=new LinearLayout.LayoutParams(dp(48),dp(48));sp.leftMargin=dp(8);sendBar.addView(send,sp);
        send.setOnClickListener(v->sendMessage());root.addView(sendBar);setContentView(root);
    }
    private void unlockAndConnect(){
        EditText password=new EditText(this);password.setSingleLine(true);password.setHint("Account password");
        password.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_PASSWORD);
        new android.app.AlertDialog.Builder(this).setTitle("Unlock encrypted messages")
            .setMessage("Enter your account password to unlock this device's message key. It will not be saved.")
            .setView(password).setCancelable(false).setNegativeButton("Cancel",(d,w)->finish())
            .setPositiveButton("Unlock",(d,w)->loadAndUnlock(password.getText().toString())).show();
    }
    private void loadAndUnlock(String password){
        status.setText("Loading account and unlocking key…");
        worker.execute(()->{
            try{
                JSONObject account=NativeApi.me(session), mine=account.optJSONObject("profile");
                if(mine==null)throw new Exception("Account profile was missing.");
                JSONObject pub=mine.optJSONObject("public_key"), backup=account.optJSONObject("key_backup");
                JSONObject unlocked;
                if(pub==null&&backup==null){
                    JSONObject created=NativeCrypto.create(password);
                    NativeApi.saveCrypto(session,created.getJSONObject("public_key"),created.getJSONObject("key_backup"));
                    pub=created.getJSONObject("public_key");mine.put("public_key",pub);unlocked=created.getJSONObject("private_key");
                }else if(pub==null||backup==null){
                    throw new Exception("This account has incomplete encryption-key data. Stop here to protect old messages.");
                }else unlocked=NativeCrypto.unlock(backup,password,pub);
                JSONObject finalKey=unlocked;
                main.post(()->{me=account;profile=mine;privateKey=finalKey;connectSocket();});
            }catch(Exception e){main.post(()->{
                status.setText(e.getMessage()==null?"Could not unlock encryption key.":e.getMessage());
                new android.app.AlertDialog.Builder(this).setTitle("Could not unlock")
                    .setMessage(status.getText()).setPositiveButton("Try again",(x,y)->unlockAndConnect())
                    .setNegativeButton("Back",(x,y)->finish()).show();
            });}
        });
    }
    private void connectSocket(){
        try{
            IO.Options opts=new IO.Options();Map<String,String> auth=new HashMap<>();
            auth.put("token",session.accessToken);opts.auth=auth;opts.transports=new String[]{"websocket","polling"};
            socket=IO.socket(NativeApi.BASE,opts);
            socket.on(Socket.EVENT_CONNECT,args->main.post(()->{
                status.setText("Online • encrypted");ready=true;
                try{JSONObject request=new JSONObject();request.put("peer",username);socket.emit("chat:open",request);}
                catch(Exception ignored){}
            }));
            socket.on("chat:history",args->{if(args.length>0&&args[0] instanceof JSONObject)main.post(()->showHistory((JSONObject)args[0]));});
            socket.on("chat:message",args->{if(args.length>0&&args[0] instanceof JSONObject)main.post(()->appendEncrypted((JSONObject)args[0]));});
            socket.on("chat:error",args->main.post(()->status.setText(args.length>0?String.valueOf(args[0]):"Chat error")));
            socket.on(Socket.EVENT_CONNECT_ERROR,args->main.post(()->status.setText("Connection error. Check internet and sign in again.")));
            socket.connect();
        }catch(Exception e){status.setText("Could not start secure connection: "+e.getMessage());}
    }
    private void showHistory(JSONObject data){
        JSONObject person=data.optJSONObject("peer");JSONArray history=data.optJSONArray("messages");
        if(person==null||history==null)return;
        peer=person;messages.removeAllViews();status.setText("Online • encrypted");
        worker.execute(()->{
            for(int i=0;i<history.length();i++){
                JSONObject m=history.optJSONObject(i);if(m==null)continue;
                try{
                    String raw=NativeCrypto.decrypt(privateKey,peer.optJSONObject("public_key"),
                        m.getString("sender_id"),m.getString("recipient_id"),m);
                    JSONObject content=new JSONObject(raw);String text=content.optString("text","[Unsupported message]");
                    boolean mine=profile.optString("id").equals(m.optString("sender_id"));
                    main.post(()->addBubble(text,mine));
                }catch(Exception e){main.post(()->addBubble("[Unable to decrypt this message]",false));}
            }
            main.post(()->{try{JSONObject read=new JSONObject();read.put("peer",username);socket.emit("chat:read",read);}catch(Exception ignored){}});
        });
    }
    private void appendEncrypted(JSONObject m){
        if(peer==null||profile==null)return;
        worker.execute(()->{
            try{
                String raw=NativeCrypto.decrypt(privateKey,peer.optJSONObject("public_key"),
                    m.getString("sender_id"),m.getString("recipient_id"),m);
                JSONObject content=new JSONObject(raw);String value=content.optString("text","[Unsupported message]");
                main.post(()->addBubble(value,profile.optString("id").equals(m.optString("sender_id"))));
                if(!profile.optString("id").equals(m.optString("sender_id"))){
                    try{JSONObject read=new JSONObject();read.put("peer",username);socket.emit("chat:read",read);}catch(Exception ignored){}
                }
            }catch(Exception e){main.post(()->addBubble("[Unable to decrypt this message]",false));}
        });
    }
    private void addBubble(String value,boolean mine){
        TextView bubble=label(value,16,TEXT,false);bubble.setPadding(dp(14),dp(10),dp(14),dp(10));
        bubble.setBackground(shape(mine?Color.rgb(0,92,75):SURFACE,16));
        LinearLayout line=new LinearLayout(this);line.setGravity(mine?Gravity.RIGHT:Gravity.LEFT);
        line.addView(bubble,new LinearLayout.LayoutParams(-2,-2));
        LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(-1,-2);lp.bottomMargin=dp(8);messages.addView(line,lp);
    }
    private void sendMessage(){
        if(!ready||peer==null||privateKey==null){status.setText("Wait for the encrypted connection.");return;}
        String value=composer.getText().toString().trim();if(value.isEmpty())return;
        composer.setText("");status.setText("Sending securely…");
        worker.execute(()->{
            try{
                JSONObject content=new JSONObject();content.put("version",1);content.put("text",value);
                JSONObject encrypted=NativeCrypto.encrypt(privateKey,peer.getJSONObject("public_key"),
                    profile.getString("id"),peer.getString("id"),content.toString());
                JSONObject payload=new JSONObject();payload.put("to",username);
                payload.put("ciphertext",encrypted.getString("ciphertext"));payload.put("iv",encrypted.getString("iv"));
                main.post(()->{
                    if(socket==null||!socket.connected()){composer.setText(value);status.setText("Offline. Message not sent.");return;}
                    socket.emit("chat:send",payload,(Ack)args->{
                        JSONObject result=args.length>0&&args[0] instanceof JSONObject?(JSONObject)args[0]:new JSONObject();
                        main.post(()->{
                            if(result.has("error")){composer.setText(value);status.setText(result.optString("error","Send failed."));return;}
                            addBubble(value,true);status.setText("Online • encrypted");
                        });
                    });
                });
            }catch(Exception e){main.post(()->{composer.setText(value);status.setText("Encryption failed. Message not sent.");});}
        });
    }
    @Override protected void onDestroy(){
        ready=false;if(socket!=null){socket.disconnect();socket.close();socket=null;}
        worker.shutdownNow();super.onDestroy();
    }
}
