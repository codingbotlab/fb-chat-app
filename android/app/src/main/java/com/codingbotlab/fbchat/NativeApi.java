package com.codingbotlab.fbchat;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

final class NativeApi {
    static final String BASE = "https://chat.fashionbazz.in";
    static final class Session {
        final String accessToken, refreshToken, email, userId;
        Session(String a, String r, String e, String id) {
            accessToken=a; refreshToken=r; email=e; userId=id;
        }
    }
    static final class Config {
        final String url, key;
        Config(String u, String k) { url=u; key=k; }
    }
    private static JSONObject request(String url, String method, JSONObject body, String token, String apiKey) throws Exception {
        HttpURLConnection c=(HttpURLConnection)new URL(url).openConnection();
        c.setRequestMethod(method); c.setConnectTimeout(12000); c.setReadTimeout(15000);
        c.setRequestProperty("Accept","application/json");
        if(apiKey!=null) c.setRequestProperty("apikey",apiKey);
        if(token!=null) c.setRequestProperty("Authorization","Bearer "+token);
        if(body!=null) {
            c.setDoOutput(true); c.setRequestProperty("Content-Type","application/json");
            try(OutputStream o=c.getOutputStream()){o.write(body.toString().getBytes(StandardCharsets.UTF_8));}
        }
        int status=c.getResponseCode();
        java.io.InputStream stream=status>=200&&status<400?c.getInputStream():c.getErrorStream();
        StringBuilder s=new StringBuilder();
        if(stream!=null) try(BufferedReader r=new BufferedReader(new InputStreamReader(stream,StandardCharsets.UTF_8))){
            String line; while((line=r.readLine())!=null)s.append(line);
        }
        c.disconnect();
        JSONObject result;
        try { result=new JSONObject(s.toString()); } catch(Exception e) { result=new JSONObject(); }
        if(status<200||status>=300) {
            String msg=result.optString("msg",result.optString("message",result.optString("error_description",result.optString("error","Request failed ("+status+")"))));
            throw new Exception(msg);
        }
        return result;
    }
    static Config config() throws Exception {
        JSONObject j=request(BASE+"/api/config","GET",null,null,null);
        if(!j.optBoolean("configured")) throw new Exception("Sign-in service is not configured.");
        return new Config(j.optString("supabaseUrl"),j.optString("supabaseAnonKey"));
    }
    static Session login(String email,String password) throws Exception {
        Config cfg=config();
        JSONObject body=new JSONObject(); body.put("email",email.trim()); body.put("password",password);
        JSONObject j=request(cfg.url+"/auth/v1/token?grant_type=password","POST",body,null,cfg.key);
        String a=j.optString("access_token"), r=j.optString("refresh_token");
        if(a.isEmpty()||r.isEmpty()) throw new Exception("Sign-in response was incomplete.");
        JSONObject user=j.optJSONObject("user");
        return new Session(a,r,email,user==null?"":user.optString("id"));
    }
    static JSONObject me(Session s) throws Exception {
        return request(BASE+"/api/me","GET",null,s.accessToken,null);
    }
    static JSONArray chats(Session s) throws Exception {
        return request(BASE+"/api/chats","GET",null,s.accessToken,null).optJSONArray("chats");
    }
    private NativeApi() {}
}