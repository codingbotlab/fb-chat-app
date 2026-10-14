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
import android.view.inputmethod.EditorInfo;
import android.widget.*;
import org.json.JSONObject;
import org.json.JSONArray;
import io.socket.client.IO;
import io.socket.client.Socket;
import io.socket.client.Ack;
import android.util.Base64;
import java.security.SecureRandom;
import java.nio.charset.StandardCharsets;
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
    private JSONObject profile, peer;
    private Socket socket;
    private LinearLayout messages;
    private EditText composer;
    private TextView status;
    private String username="", displayName="";
    private boolean ready=false;
    private final SecureRandom random=new SecureRandom();

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(BG);getWindow().setNavigationBarColor(BG);
        username=getIntent().getStringExtra("username");displayName=getIntent().getStringExtra("displayName");
        if(username==null||username.trim().isEmpty()){finish();return;}
        android.content.SharedPreferences pref=getSharedPreferences("fbchat_native_session",MODE_PRIVATE);
        String a=pref.getString("access",""),r=pref.getString("refresh","");
        if(a.isEmpty()||r.isEmpty()){finish();return;}
        session=new NativeApi.Session(a,r,pref.getString("email",""),pref.getString("uid",""));
        buildUi();connect();
    }
    private int dp(float n){return (int)(n*getResources().getDisplayMetrics().density+.5f);}
    private GradientDrawable shape(int color,int radius){GradientDrawable d=new GradientDrawable();d.setColor(color);d.setCornerRadius(dp(radius));return d;}
    private TextView label(String s,int size,int color,boolean bold){
        TextView t=new TextView(this);t.setText(s);t.setTextSize(size);t.setTextColor(color);
        if(bold)t.setTypeface(Typeface.DEFAULT,Typeface.BOLD);return t;
    }
    private ImageView icon(int resource,int tint){
        ImageView view=new ImageView(this);view.setImageResource(resource);view.setColorFilter(tint);
        view.setScaleType(ImageView.ScaleType.CENTER_INSIDE);return view;
    }
    private void buildUi(){
        LinearLayout root=new LinearLayout(this);root.setOrientation(LinearLayout.VERTICAL);root.setBackgroundColor(BG);
        LinearLayout header=new LinearLayout(this);header.setGravity(Gravity.CENTER_VERTICAL);header.setPadding(dp(10),dp(5),dp(12),dp(5));header.setBackgroundColor(SURFACE);
        ImageView back=icon(R.drawable.ic_back,GREEN);back.setPadding(dp(8),dp(8),dp(8),dp(8));
        header.addView(back,new LinearLayout.LayoutParams(dp(42),dp(52)));back.setOnClickListener(v->finish());
        LinearLayout names=new LinearLayout(this);names.setOrientation(LinearLayout.VERTICAL);
        names.addView(label(displayName==null||displayName.isEmpty()?"@"+username:displayName,17,TEXT,true));
        status=label("Connecting…",12,MUTED,false);names.addView(status);
        header.addView(names,new LinearLayout.LayoutParams(0,-2,1));
        ImageView more=icon(R.drawable.ic_more,TEXT);more.setPadding(dp(8),dp(8),dp(8),dp(8));
        header.addView(more,new LinearLayout.LayoutParams(dp(36),dp(48)));
        more.setOnClickListener(v->new android.app.AlertDialog.Builder(this).setItems(new String[]{"View contact","Clear this screen"},(dialog,which)->{
            if(which==0)new android.app.AlertDialog.Builder(this).setTitle(displayName).setMessage("@"+username).setPositiveButton("OK",null).show();
            else messages.removeAllViews();
        }).show());
        root.addView(header,new LinearLayout.LayoutParams(-1,dp(58)));
        ScrollView scroll=new ScrollView(this);scroll.setFillViewport(true);
        messages=new LinearLayout(this);messages.setOrientation(LinearLayout.VERTICAL);messages.setPadding(dp(12),dp(12),dp(12),dp(12));
        scroll.addView(messages);root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
        LinearLayout bar=new LinearLayout(this);bar.setGravity(Gravity.CENTER_VERTICAL);bar.setPadding(dp(8),dp(7),dp(8),dp(7));bar.setBackgroundColor(SURFACE);
        composer=new EditText(this);composer.setSingleLine(false);composer.setMaxLines(4);composer.setTextColor(TEXT);composer.setHintTextColor(MUTED);
        composer.setHint("Message");composer.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_FLAG_CAP_SENTENCES|InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        composer.setImeOptions(EditorInfo.IME_ACTION_SEND);composer.setBackground(shape(Color.rgb(42,57,64),24));composer.setPadding(dp(16),dp(8),dp(16),dp(8));
        bar.addView(composer,new LinearLayout.LayoutParams(0,dp(48),1));
        ImageView send=icon(R.drawable.ic_send,Color.WHITE);send.setPadding(dp(12),dp(12),dp(12),dp(12));
        send.setBackground(shape(GREEN,28));send.setContentDescription("Send message");
        LinearLayout.LayoutParams sl=new LinearLayout.LayoutParams(dp(48),dp(48));sl.leftMargin=dp(8);bar.addView(send,sl);
        send.setOnClickListener(v->sendMessage());
        composer.setOnEditorActionListener((v,action,event)->{if(action==EditorInfo.IME_ACTION_SEND){sendMessage();return true;}return false;});
        root.addView(bar,new LinearLayout.LayoutParams(-1,-2));setContentView(root);
    }
    private void connect(){
        status.setText("Connecting…");
        worker.execute(()->{
            try{
                JSONObject account=NativeApi.me(session),mine=account.optJSONObject("profile");
                if(mine==null)throw new Exception("Could not load your account.");
                main.post(()->{profile=mine;connectSocket();});
            }catch(Exception e){main.post(()->status.setText("Connection failed. Please sign in again."));}
        });
    }
    private void connectSocket(){
        try{
            IO.Options opts=new IO.Options();Map<String,String> auth=new HashMap<>();auth.put("token",session.accessToken);
            opts.auth=auth;opts.transports=new String[]{"websocket","polling"};socket=IO.socket(NativeApi.BASE,opts);
            socket.on(Socket.EVENT_CONNECT,args->main.post(()->{
                ready=true;status.setText("online");
                try{JSONObject req=new JSONObject();req.put("peer",username);socket.emit("chat:open",req);}catch(Exception ignored){}
            }));
            socket.on("chat:history",args->{if(args.length>0&&args[0] instanceof JSONObject)main.post(()->showHistory((JSONObject)args[0]));});
            socket.on("chat:message",args->{if(args.length>0&&args[0] instanceof JSONObject)main.post(()->appendMessage((JSONObject)args[0]));});
            socket.on("chat:error",args->main.post(()->status.setText(args.length>0?String.valueOf(args[0]):"Could not connect.")));
            socket.on(Socket.EVENT_CONNECT_ERROR,args->main.post(()->status.setText("Offline • reconnecting…")));
            socket.on("chat:receipts",args->main.post(()->status.setText("online")));
            socket.connect();
        }catch(Exception e){status.setText("Could not connect.");}
    }
    private void showHistory(JSONObject data){
        JSONObject person=data.optJSONObject("peer");JSONArray history=data.optJSONArray("messages");
        if(person==null||history==null)return;
        peer=person;messages.removeAllViews();status.setText(ready?"online":"offline");
        for(int i=0;i<history.length();i++){JSONObject m=history.optJSONObject(i);if(m!=null)appendMessage(m);}
    }
    private String plainText(JSONObject message){
        String raw=message.optString("ciphertext","");
        if(raw.startsWith("PLAIN:")){
            String value=raw.substring(6);
            try{JSONObject content=new JSONObject(value);if(content.optInt("version")==1)return content.optString("text",value);}catch(Exception ignored){}
            return value;
        }
        return "[Older encrypted message]";
    }
    private void appendMessage(JSONObject message){
        if(profile==null)return;
        String value=plainText(message);
        boolean mine=profile.optString("id").equals(message.optString("sender_id"));
        addBubble(value,mine);
    }
    private void addBubble(String value,boolean mine){
        TextView bubble=label(value,16,TEXT,false);bubble.setMaxWidth((int)(getResources().getDisplayMetrics().widthPixels*.78));
        bubble.setPadding(dp(14),dp(10),dp(14),dp(10));bubble.setBackground(shape(mine?Color.rgb(0,92,75):SURFACE,16));
        LinearLayout line=new LinearLayout(this);line.setGravity(mine?Gravity.RIGHT:Gravity.LEFT);
        line.addView(bubble,new LinearLayout.LayoutParams(-2,-2));
        LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(-1,-2);lp.bottomMargin=dp(7);messages.addView(line,lp);
    }
    private void sendMessage(){
        if(!ready||socket==null||peer==null){status.setText("Connecting…");return;}
        String value=composer.getText().toString().trim();if(value.isEmpty())return;
        composer.setText("");
        try{
            JSONObject payload=new JSONObject();payload.put("to",username);payload.put("ciphertext","PLAIN:"+value);
            byte[] iv=new byte[12];random.nextBytes(iv);
            payload.put("iv",Base64.encodeToString(iv,Base64.URL_SAFE|Base64.NO_WRAP|Base64.NO_PADDING));
            socket.emit("chat:send",payload,(Ack)args->main.post(()->{
                JSONObject result=args.length>0&&args[0] instanceof JSONObject?(JSONObject)args[0]:new JSONObject();
                if(result.has("error")){status.setText(result.optString("error","Message failed."));composer.setText(value);return;}
                JSONObject saved=result.optJSONObject("message");
                if(saved!=null)appendMessage(saved);else addBubble(value,true);
                status.setText("online");
            }));
        }catch(Exception e){composer.setText(value);status.setText("Message could not be sent.");}
    }
    @Override protected void onDestroy(){
        ready=false;if(socket!=null){socket.disconnect();socket.close();socket=null;}
        worker.shutdownNow();super.onDestroy();
    }
}
