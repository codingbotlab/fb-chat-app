package com.codingbotlab.fbchat;

import android.content.Context;
import android.util.Base64;
import org.json.JSONObject;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

final class NativeKeyStore {
    private static final String PREFS="fbchat_native_keys";
    private static String alias(String userId){return "fbchat_msgkey_"+userId.replaceAll("[^A-Za-z0-9]","_");}
    private static SecretKey key(String name,boolean create)throws Exception{
        KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);
        if(store.containsAlias(name))return (SecretKey)store.getKey(name,null);
        if(!create)return null;
        KeyGenerator gen=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
        gen.init(new KeyGenParameterSpec.Builder(name,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true).build());
        return gen.generateKey();
    }
    static void save(Context context,String userId,JSONObject privateJwk)throws Exception{
        String name=alias(userId);Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE,key(name,true));
        byte[] encrypted=cipher.doFinal(privateJwk.toString().getBytes(StandardCharsets.UTF_8));
        String packed=Base64.encodeToString(cipher.getIV(),Base64.NO_WRAP)+":"+
            Base64.encodeToString(encrypted,Base64.NO_WRAP);
        context.getSharedPreferences(PREFS,Context.MODE_PRIVATE).edit().putString(userId,packed).commit();
    }
    static JSONObject load(Context context,String userId)throws Exception{
        String packed=context.getSharedPreferences(PREFS,Context.MODE_PRIVATE).getString(userId,null);
        if(packed==null)return null;int split=packed.indexOf(':');if(split<1)return null;
        SecretKey secret=key(alias(userId),false);if(secret==null)return null;
        byte[] iv=Base64.decode(packed.substring(0,split),Base64.DEFAULT);
        byte[] ciphertext=Base64.decode(packed.substring(split+1),Base64.DEFAULT);
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE,secret,new GCMParameterSpec(128,iv));
        return new JSONObject(new String(cipher.doFinal(ciphertext),StandardCharsets.UTF_8));
    }
    private NativeKeyStore(){}
}
