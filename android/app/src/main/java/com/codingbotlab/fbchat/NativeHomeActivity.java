package com.codingbotlab.fbchat;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.EditText;
import android.widget.ImageView;
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

    private LinearLayout root, body, contactListContainer;
    private EditText emailInput, passwordInput, contactSearch;
    private TextView status;
    private NativeApi.Session session;
    private JSONObject me;
    private JSONArray lastChats=new JSONArray(), directoryUsers=new JSONArray();
    private boolean busy=false;
    private String currentScreen="Chats";

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);
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
        GradientDrawable d=new GradientDrawable();d.setColor(color);d.setCornerRadius(dp(radius));return d;
    }
    private TextView text(String value,int size,int color,boolean bold){
        TextView t=new TextView(this);t.setText(value);t.setTextSize(size);t.setTextColor(color);
        t.setGravity(Gravity.CENTER_VERTICAL);
        if(bold)t.setTypeface(Typeface.DEFAULT,Typeface.BOLD);
        return t;
    }
    private LinearLayout vertical(){LinearLayout l=new LinearLayout(this);l.setOrientation(LinearLayout.VERTICAL);return l;}
    private ImageView icon(int resource,int tint){
        ImageView view=new ImageView(this);
        view.setImageResource(resource);
        view.setColorFilter(tint);
        view.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
        return view;
    }
    private ImageView iconButton(int resource,String title,Runnable action){
        ImageView view=icon(resource,TEXT);
        view.setContentDescription(title);
        view.setPadding(dp(10),dp(10),dp(10),dp(10));
        view.setBackground(shape(SURFACE,14));
        view.setClickable(true);view.setFocusable(true);
        view.setOnClickListener(v->action.run());
        return view;
    }
    private void base(String subtitle){
        root=vertical();root.setBackgroundColor(BG);
        LinearLayout top=new LinearLayout(this);
        top.setGravity(Gravity.CENTER_VERTICAL);top.setPadding(dp(16),dp(4),dp(12),dp(4));
        top.setBackgroundColor(SURFACE);
        top.addView(text("FB Chat",23,GREEN,true),new LinearLayout.LayoutParams(0,dp(54),1));
        if(session!=null){
            ImageView add=iconButton(R.drawable.ic_add,"New chat",this::startNewChat);
            LinearLayout.LayoutParams actionLp=new LinearLayout.LayoutParams(dp(42),dp(42));
            actionLp.rightMargin=dp(8);top.addView(add,actionLp);
            top.addView(iconButton(R.drawable.ic_more,"More options",this::openMenu),
                    new LinearLayout.LayoutParams(dp(42),dp(42)));
        }
        root.addView(top,new LinearLayout.LayoutParams(-1,dp(58)));
        TextView heading=text(subtitle,14,MUTED,false);
        heading.setPadding(dp(18),dp(4),dp(18),0);
        root.addView(heading,new LinearLayout.LayoutParams(-1,dp(32)));

        ScrollView scroll=new ScrollView(this);scroll.setFillViewport(true);
        body=vertical();body.setPadding(dp(16),dp(8),dp(16),dp(12));scroll.addView(body);
        root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
        status=text("",12,Color.rgb(255,170,120),false);
        status.setPadding(dp(16),0,dp(16),0);
        root.addView(status,new LinearLayout.LayoutParams(-1,dp(25)));
        if(session!=null)root.addView(bottomNavigation(),new LinearLayout.LayoutParams(-1,dp(66)));
        setContentView(root);
    }

    private void showLogin(){
        currentScreen="Login";
        base("Private messaging, made simple");
        body.addView(text("Welcome back",25,TEXT,true),new LinearLayout.LayoutParams(-1,dp(48)));
        body.addView(text("Sign in to your existing FB Chat account.",15,MUTED,false),new LinearLayout.LayoutParams(-1,dp(48)));
        emailInput=field("Email address",InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        LinearLayout.LayoutParams fp=new LinearLayout.LayoutParams(-1,dp(56));fp.topMargin=dp(18);body.addView(emailInput,fp);
        passwordInput=field("Password",InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_PASSWORD);
        fp=new LinearLayout.LayoutParams(-1,dp(56));fp.topMargin=dp(12);body.addView(passwordInput,fp);
        TextView login=actionButton("Sign in");
        fp=new LinearLayout.LayoutParams(-1,dp(54));fp.topMargin=dp(20);body.addView(login,fp);
        login.setOnClickListener(v->doLogin());
        passwordInput.setOnEditorActionListener((v,action,event)->{if(action==EditorInfo.IME_ACTION_DONE){doLogin();return true;}return false;});
        TextView foot=text("Native Android app • HTTPS connection",12,MUTED,false);
        foot.setGravity(Gravity.CENTER);fp=new LinearLayout.LayoutParams(-1,dp(48));fp.topMargin=dp(12);body.addView(foot,fp);
        status.setText("Sign in with your existing account.");
    }
    private EditText field(String hint,int type){
        EditText e=new EditText(this);e.setSingleLine(true);e.setTextSize(16);e.setTextColor(TEXT);
        e.setHintTextColor(MUTED);e.setHint(hint);e.setInputType(type);e.setPadding(dp(16),0,dp(16),0);
        e.setBackground(shape(SURFACE,14));return e;
    }
    private TextView actionButton(String label){
        TextView b=text(label,15,Color.WHITE,true);b.setGravity(Gravity.CENTER);
        b.setBackground(shape(GREEN,14));b.setClickable(true);b.setFocusable(true);return b;
    }

    private void doLogin(){
        if(busy)return;
        String email=emailInput.getText().toString().trim(), password=passwordInput.getText().toString();
        if(email.isEmpty()||password.isEmpty()){status.setText("Enter your email and password.");return;}
        busy=true;status.setText("Signing in…");
        worker.execute(()->{
            try{
                NativeApi.Session s=NativeApi.login(email,password);JSONObject account=NativeApi.me(s);
                main.post(()->{session=s;me=account;saveSession();busy=false;showChats();});
            }catch(Exception e){main.post(()->{busy=false;status.setText(e.getMessage()==null?"Sign-in failed.":e.getMessage());});}
        });
    }
    private void saveSession(){
        getSharedPreferences(PREFS,MODE_PRIVATE).edit().putString("access",session.accessToken)
                .putString("refresh",session.refreshToken).putString("email",session.email)
                .putString("uid",session.userId).apply();
    }
    private void loadAccount(){
        base("Loading your conversations");
        status.setText("Connecting to FB Chat…");
        worker.execute(()->{
            try{
                JSONObject a=NativeApi.me(session);JSONArray c=NativeApi.chats(session);
                main.post(()->{me=a;showChats(c);});
            }catch(Exception e){main.post(()->{
                getSharedPreferences(PREFS,MODE_PRIVATE).edit().clear().apply();session=null;showLogin();
                status.setText("Session expired. Please sign in again.");
            });}
        });
    }
    private void showChats(){
        if(session==null)return;
        busy=true;
        worker.execute(()->{
            try{JSONArray c=NativeApi.chats(session);main.post(()->{busy=false;showChats(c);});}
            catch(Exception e){main.post(()->{busy=false;status.setText("Could not load chats. Check your connection.");});}
        });
    }
    private void showChats(JSONArray chats){
        currentScreen="Chats";
        lastChats=chats==null?new JSONArray():chats;
        base("Chats");
        LinearLayout heading=new LinearLayout(this);heading.setGravity(Gravity.CENTER_VERTICAL);
        heading.addView(text("Recent conversations",18,TEXT,true),new LinearLayout.LayoutParams(0,dp(48),1));
        ImageView newChat=iconButton(R.drawable.ic_add,"New chat",this::startNewChat);
        heading.addView(newChat,new LinearLayout.LayoutParams(dp(42),dp(42)));
        body.addView(heading);

        if(lastChats.length()==0){
            LinearLayout empty=vertical();empty.setGravity(Gravity.CENTER);
            ImageView chatIcon=icon(R.drawable.ic_chat,GREEN);
            LinearLayout.LayoutParams ip=new LinearLayout.LayoutParams(dp(54),dp(54));ip.bottomMargin=dp(12);
            empty.addView(chatIcon,ip);
            TextView title=text("No conversations yet",19,TEXT,true);title.setGravity(Gravity.CENTER);empty.addView(title);
            TextView hint=text("Open Contacts to find people on FB Chat, then send your first message.",14,MUTED,false);
            hint.setGravity(Gravity.CENTER);hint.setPadding(dp(12),dp(8),dp(12),dp(12));empty.addView(hint);
            TextView find=actionButton("Find contacts");LinearLayout.LayoutParams fl=new LinearLayout.LayoutParams(-1,dp(48));fl.topMargin=dp(10);empty.addView(find,fl);
            find.setOnClickListener(v->showContacts());
            LinearLayout.LayoutParams el=new LinearLayout.LayoutParams(-1,dp(300));body.addView(empty,el);
        } else {
            for(int i=0;i<lastChats.length();i++){
                JSONObject item=lastChats.optJSONObject(i);if(item==null)continue;
                JSONObject peer=item.optJSONObject("peer");if(peer==null)continue;
                String username=peer.optString("username","");
                String name=peer.optString("display_name",username.isEmpty()?"FB Chat user":username);
                JSONObject last=item.optJSONObject("last_message");
                String preview=last==null?"Tap to start messaging":preview(last.optString("ciphertext",""));
                addPersonRow(body,peer,name,username,preview);
            }
        }
        status.setText("");
    }
    private String preview(String raw){
        if(raw.startsWith("PLAIN:")){
            String value=raw.substring(6);
            try{JSONObject o=new JSONObject(value);if(o.optInt("version")==1)return o.optString("text","Message");}catch(Exception ignored){}
            return value;
        }
        return "Older encrypted message";
    }
    private void addPersonRow(LinearLayout target,JSONObject person,String name,String username,String detail){
        LinearLayout row=new LinearLayout(this);row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(10),dp(8),dp(10),dp(8));row.setBackground(shape(SURFACE,16));
        TextView avatar=text(initials(name),18,Color.WHITE,true);avatar.setGravity(Gravity.CENTER);avatar.setBackground(shape(GREEN,32));
        row.addView(avatar,new LinearLayout.LayoutParams(dp(48),dp(48)));
        LinearLayout labels=vertical();labels.setPadding(dp(12),0,dp(8),0);
        labels.addView(text(name,16,TEXT,true),new LinearLayout.LayoutParams(-1,dp(27)));
        String sub=detail==null||detail.isEmpty()?"@"+username:detail;
        labels.addView(text(sub,13,MUTED,false),new LinearLayout.LayoutParams(-1,dp(23)));
        row.addView(labels,new LinearLayout.LayoutParams(0,dp(56),1));
        ImageView arrow=icon(R.drawable.ic_back,MUTED);
        row.addView(arrow,new LinearLayout.LayoutParams(dp(22),dp(22)));
        LinearLayout.LayoutParams rp=new LinearLayout.LayoutParams(-1,dp(72));rp.bottomMargin=dp(8);target.addView(row,rp);
        row.setOnClickListener(v->openConversation(username,name));
    }
    private String initials(String name){
        String value=name==null?"?":name.trim();return value.isEmpty()?"?":value.substring(0,1).toUpperCase();
    }
    private void openConversation(String username,String name){
        if(username==null||username.trim().isEmpty()){status.setText("This account has no username yet.");return;}
        Intent intent=new Intent(this,NativeConversationActivity.class);
        intent.putExtra("username",username);intent.putExtra("displayName",name);startActivity(intent);
    }
    private void startNewChat(){ showContacts(); }
    private void promptUsername(){
        EditText input=field("Username",InputType.TYPE_CLASS_TEXT);
        new AlertDialog.Builder(this).setTitle("New chat").setMessage("Enter the person's FB Chat username.")
                .setView(input).setNegativeButton("Cancel",null).setPositiveButton("Open",(dialog,which)->{
                    String handle=input.getText().toString().trim().replace("@","");
                    if(handle.isEmpty()){status.setText("Enter a username.");return;}
                    openConversation(handle,"@"+handle);
                }).show();
    }

    private void showContacts(){
        if(session==null)return;
        currentScreen="Contacts";directoryUsers=new JSONArray();
        base("Contacts");
        LinearLayout searchBar=new LinearLayout(this);searchBar.setGravity(Gravity.CENTER_VERTICAL);
        searchBar.setPadding(dp(12),0,dp(10),0);searchBar.setBackground(shape(SURFACE,14));
        searchBar.addView(icon(R.drawable.ic_search,MUTED),new LinearLayout.LayoutParams(dp(22),dp(22)));
        contactSearch=field("Search name or username",InputType.TYPE_CLASS_TEXT);
        contactSearch.setBackgroundColor(Color.TRANSPARENT);
        LinearLayout.LayoutParams sp=new LinearLayout.LayoutParams(0,dp(50),1);sp.leftMargin=dp(10);
        searchBar.addView(contactSearch,sp);body.addView(searchBar);
        LinearLayout section=new LinearLayout(this);section.setGravity(Gravity.CENTER_VERTICAL);
        section.addView(text("People on FB Chat",17,TEXT,true),new LinearLayout.LayoutParams(0,dp(46),1));
        TextView byUsername=actionButton("By username");
        LinearLayout.LayoutParams userLp=new LinearLayout.LayoutParams(dp(126),dp(38));section.addView(byUsername,userLp);
        byUsername.setOnClickListener(v->promptUsername());
        LinearLayout.LayoutParams hp=new LinearLayout.LayoutParams(-1,dp(46));hp.topMargin=dp(8);body.addView(section,hp);
        contactListContainer=vertical();body.addView(contactListContainer,new LinearLayout.LayoutParams(-1,-2));
        renderContacts("");
        contactSearch.addTextChangedListener(new TextWatcher(){
            @Override public void beforeTextChanged(CharSequence s,int start,int count,int after){}
            @Override public void onTextChanged(CharSequence s,int start,int before,int count){renderContacts(s.toString());}
            @Override public void afterTextChanged(Editable e){}
        });
        status.setText("Loading registered users…");
        worker.execute(()->{
            try{
                JSONArray users=NativeApi.users(session);
                main.post(()->{
                    directoryUsers=users==null?new JSONArray():users;
                    if(!"Contacts".equals(currentScreen))return;
                    renderContacts(contactSearch==null?"":contactSearch.getText().toString());
                    status.setText(directoryUsers.length()+" members");
                });
            }catch(Exception e){main.post(()->{
                if(!"Contacts".equals(currentScreen))return;
                renderContacts(contactSearch==null?"":contactSearch.getText().toString());
                status.setText("Could not load users. Check your connection and tap Retry.");
            });}
        });
    }
    private void renderContacts(String query){
        if(contactListContainer==null)return;
        contactListContainer.removeAllViews();
        String q=query==null?"":query.trim().toLowerCase();
        int shown=0;
        for(int i=0;i<directoryUsers.length();i++){
            JSONObject person=directoryUsers.optJSONObject(i);if(person==null)continue;
            String username=person.optString("username","");
            String name=person.optString("display_name",username);
            if(!(name+" "+username).toLowerCase().contains(q))continue;
            addPersonRow(contactListContainer,person,name,username,"@"+username);
            shown++;
        }
        if(shown==0){
            TextView empty=text(directoryUsers.length()==0?"Loading members or no other accounts yet.":"No matching contacts.",14,MUTED,false);
            empty.setGravity(Gravity.CENTER);empty.setPadding(dp(12),dp(24),dp(12),dp(24));
            contactListContainer.addView(empty,new LinearLayout.LayoutParams(-1,dp(110)));
        }
        if(directoryUsers.length()==0){
            TextView retry=actionButton("Retry");
            LinearLayout.LayoutParams rp=new LinearLayout.LayoutParams(-1,dp(46));rp.topMargin=dp(8);contactListContainer.addView(retry,rp);
            retry.setOnClickListener(v->showContacts());
        }
    }

    private void showProfile(){
        currentScreen="Profile";base("Profile & settings");
        JSONObject p=me==null?null:me.optJSONObject("profile");
        LinearLayout hero=vertical();hero.setGravity(Gravity.CENTER_HORIZONTAL);hero.setPadding(dp(16),dp(18),dp(16),dp(18));
        hero.setBackground(shape(SURFACE,18));
        TextView avatar=text(initials(p==null?"F":p.optString("display_name","FB Chat")),30,Color.WHITE,true);
        avatar.setGravity(Gravity.CENTER);avatar.setBackground(shape(GREEN,48));
        hero.addView(avatar,new LinearLayout.LayoutParams(dp(86),dp(86)));
        TextView name=text(p==null?"Your profile":p.optString("display_name","Your profile"),21,TEXT,true);
        name.setGravity(Gravity.CENTER);LinearLayout.LayoutParams np=new LinearLayout.LayoutParams(-1,dp(42));np.topMargin=dp(10);hero.addView(name,np);
        TextView handle=text(p==null?"":"@"+p.optString("username",""),14,MUTED,false);
        handle.setGravity(Gravity.CENTER);hero.addView(handle,new LinearLayout.LayoutParams(-1,dp(28)));
        TextView email=text(session.email,13,MUTED,false);email.setGravity(Gravity.CENTER);
        hero.addView(email,new LinearLayout.LayoutParams(-1,dp(28)));
        body.addView(hero);
        addSettingsRow(R.drawable.ic_contacts,"Contacts","Browse registered FB Chat members",this::showContacts);
        addSettingsRow(R.drawable.ic_delete,"Delete old encrypted messages","Remove unreadable legacy messages from this account",this::confirmDeleteLegacyMessages);
        addSettingsRow(R.drawable.ic_settings,"Sign out","Sign out from this device",this::confirmSignOut);
        TextView note=text("New messages use simple text mode. Older encrypted messages cannot be read in the native chat.",13,MUTED,false);
        note.setPadding(dp(4),dp(14),dp(4),dp(12));body.addView(note);
    }
    private void addSettingsRow(int iconRes,String title,String detail,Runnable action){
        LinearLayout row=new LinearLayout(this);row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(12),dp(10),dp(12),dp(10));row.setBackground(shape(SURFACE,14));
        row.addView(icon(iconRes,GREEN),new LinearLayout.LayoutParams(dp(26),dp(26)));
        LinearLayout labels=vertical();labels.setPadding(dp(12),0,0,0);
        labels.addView(text(title,15,TEXT,true),new LinearLayout.LayoutParams(-1,dp(27)));
        labels.addView(text(detail,12,MUTED,false),new LinearLayout.LayoutParams(-1,dp(22)));
        row.addView(labels,new LinearLayout.LayoutParams(0,dp(54),1));
        row.addView(icon(R.drawable.ic_back,MUTED),new LinearLayout.LayoutParams(dp(20),dp(20)));
        LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(-1,dp(72));lp.topMargin=dp(9);body.addView(row,lp);
        row.setOnClickListener(v->action.run());
    }
    private void confirmDeleteLegacyMessages(){
        new AlertDialog.Builder(this)
                .setTitle("Delete old encrypted messages?")
                .setMessage("This permanently deletes all older encrypted messages belonging to your account, across its chats and devices. New plain-text messages will be kept. This cannot be undone.")
                .setNegativeButton("Cancel",null)
                .setPositiveButton("Delete old messages",(dialog,which)->deleteLegacyMessages())
                .show();
    }
    private void deleteLegacyMessages(){
        if(busy||session==null)return;
        busy=true;status.setText("Deleting old encrypted messages…");
        worker.execute(()->{
            try{
                JSONObject result=NativeApi.deleteOldEncryptedMessages(session);
                int count=result.optInt("deletedCount",0);
                boolean complete=result.optBoolean("completed",true);
                main.post(()->{
                    busy=false;
                    String msg=complete?"Deleted "+count+" older encrypted messages.":"Some old messages may remain. Run cleanup again.";
                    Toast.makeText(this,msg,Toast.LENGTH_LONG).show();status.setText(msg);
                    showChats();
                });
            }catch(Exception e){main.post(()->{
                busy=false;status.setText("Could not delete legacy messages. Update the server and retry.");
                Toast.makeText(this,"Cleanup unavailable: "+(e.getMessage()==null?"server error":e.getMessage()),Toast.LENGTH_LONG).show();
            });}
        });
    }
    private void confirmSignOut(){
        new AlertDialog.Builder(this).setTitle("Sign out?")
                .setMessage("This removes the saved session from this device.")
                .setNegativeButton("Cancel",null).setPositiveButton("Sign out",(dialog,which)->signOut()).show();
    }
    private void signOut(){
        session=null;me=null;lastChats=new JSONArray();directoryUsers=new JSONArray();
        getSharedPreferences(PREFS,MODE_PRIVATE).edit().clear().apply();showLogin();
    }

    private LinearLayout bottomNavigation(){
        LinearLayout nav=new LinearLayout(this);nav.setGravity(Gravity.CENTER);nav.setBackgroundColor(SURFACE);
        String[][] tabs={{"Chats","ic_chat"},{"Updates","ic_updates"},{"Communities","ic_groups"},{"Calls","ic_calls"}};
        int[] ids={R.drawable.ic_chat,R.drawable.ic_updates,R.drawable.ic_groups,R.drawable.ic_calls};
        for(int i=0;i<tabs.length;i++){
            final String tab=tabs[i][0];
            LinearLayout item=vertical();item.setGravity(Gravity.CENTER);item.setPadding(0,dp(4),0,dp(3));
            int tint=tab.equals(currentScreen)?GREEN:MUTED;
            ImageView glyph=icon(ids[i],tint);
            item.addView(glyph,new LinearLayout.LayoutParams(dp(24),dp(25)));
            TextView title=text(tab,10,tint,tab.equals(currentScreen));title.setGravity(Gravity.CENTER);
            item.addView(title,new LinearLayout.LayoutParams(-1,dp(22)));
            nav.addView(item,new LinearLayout.LayoutParams(0,dp(62),1));
            item.setClickable(true);item.setFocusable(true);item.setOnClickListener(v->showTab(tab));
        }
        return nav;
    }
    private void showTab(String tab){
        if("Chats".equals(tab)){showChats(lastChats);return;}
        if("Contacts".equals(tab)){showContacts();return;}
        if("Profile".equals(tab)){showProfile();return;}
        currentScreen=tab;base(tab);
        int iconRes="Calls".equals(tab)?R.drawable.ic_calls:("Updates".equals(tab)?R.drawable.ic_updates:R.drawable.ic_groups);
        body.addView(icon(iconRes,GREEN),new LinearLayout.LayoutParams(dp(50),dp(50)));
        body.addView(text(tab,22,TEXT,true),new LinearLayout.LayoutParams(-1,dp(48)));
        String message="Updates".equals(tab)?"Status publishing is not connected yet."
                :"Communities".equals(tab)?"Group/community chat is not connected yet."
                :"Voice and video call history will appear here.";
        body.addView(text(message,14,MUTED,false),new LinearLayout.LayoutParams(-1,dp(52)));
    }
    private void openMenu(){
        String[] options={"New chat","Contacts","Profile & settings","Delete old encrypted messages","Sign out"};
        new AlertDialog.Builder(this).setItems(options,(dialog,which)->{
            if(which==0)showContacts();
            else if(which==1)showContacts();
            else if(which==2)showProfile();
            else if(which==3)confirmDeleteLegacyMessages();
            else confirmSignOut();
        }).show();
    }

    @Override protected void onDestroy(){worker.shutdownNow();super.onDestroy();}
}
