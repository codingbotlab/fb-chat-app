package com.codingbotlab.fbchat;

import android.util.Base64;
import org.json.JSONObject;
import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.AlgorithmParameters;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPrivateKeySpec;
import java.security.spec.ECPublicKeySpec;
import java.security.spec.ECPoint;
import java.util.Arrays;

final class NativeCrypto {
    private static final byte[] UTF8 = new byte[0];
    private static byte[] decode(String s) { return Base64.decode(s.replace('-','+').replace('_','/'), Base64.DEFAULT); }
    private static String encode(byte[] b) { return Base64.encodeToString(b, Base64.URL_SAFE|Base64.NO_PADDING|Base64.NO_WRAP); }
    private static byte[] bytes(String s) { return s.getBytes(StandardCharsets.UTF_8); }
    private static ECParameterSpec params() throws Exception {
        AlgorithmParameters p=AlgorithmParameters.getInstance("EC");
        p.init(new ECGenParameterSpec("secp256r1"));
        return p.getParameterSpec(ECParameterSpec.class);
    }
    private static BigInteger unsigned(String s) { return new BigInteger(1,decode(s)); }
    private static JSONObject publicPart(JSONObject jwk) throws Exception {
        JSONObject p=new JSONObject(); p.put("kty",jwk.getString("kty")); p.put("crv",jwk.getString("crv"));
        p.put("x",jwk.getString("x")); p.put("y",jwk.getString("y")); return p;
    }
    static String fingerprint(JSONObject jwk) throws Exception {
        JSONObject p=publicPart(jwk);
        String input=p.getString("kty")+"."+p.getString("crv")+"."+p.getString("x")+"."+p.getString("y");
        return encode(MessageDigest.getInstance("SHA-256").digest(bytes(input)));
    }
    static JSONObject unlock(JSONObject bundle,String password,JSONObject pub) throws Exception {
        if(bundle==null||bundle.optInt("version")!=1) throw new Exception("No supported encrypted key backup exists.");
        String fp=fingerprint(pub);
        if(!bundle.optString("fingerprint",fp).equals(fp)) throw new Exception("Encryption-key fingerprint mismatch. Stopped for safety.");
        int iterations=bundle.optInt("iterations",310000);
        if(iterations<100000||iterations>1000000) throw new Exception("Unsupported key-backup settings.");
        PBEKeySpec spec=new PBEKeySpec(password.toCharArray(),decode(bundle.getString("salt")),iterations,256);
        byte[] raw=SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded(); spec.clearPassword();
        Cipher aes=Cipher.getInstance("AES/GCM/NoPadding");
        aes.init(Cipher.DECRYPT_MODE,new SecretKeySpec(raw,"AES"),new GCMParameterSpec(128,decode(bundle.getString("iv"))));
        JSONObject parsed=new JSONObject(new String(aes.doFinal(decode(bundle.getString("ciphertext"))),StandardCharsets.UTF_8));
        JSONObject jwk=parsed.getJSONObject("privateJwk");
        if(!fp.equals(parsed.optString("fingerprint"))||!jwk.has("d")) throw new Exception("Recovered key does not match this account.");
        return jwk;
    }
    private static byte[] hkdf(byte[] ikm,byte[] info) throws Exception {
        Mac mac=Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(bytes("fb-chat-message-key-v1"),"HmacSHA256"));
        byte[] prk=mac.doFinal(ikm);
        mac.init(new SecretKeySpec(prk,"HmacSHA256"));
        mac.update(info); mac.update((byte)1);
        return Arrays.copyOf(mac.doFinal(),32);
    }
    private static byte[] shared(JSONObject privateJwk,JSONObject peer) throws Exception {
        ECParameterSpec p=params();
        KeyFactory kf=KeyFactory.getInstance("EC");
        PrivateKey sk=kf.generatePrivate(new ECPrivateKeySpec(unsigned(privateJwk.getString("d")),p));
        PublicKey pk=kf.generatePublic(new ECPublicKeySpec(new ECPoint(unsigned(peer.getString("x")),unsigned(peer.getString("y"))),p));
        KeyAgreement ka=KeyAgreement.getInstance("ECDH"); ka.init(sk); ka.doPhase(pk,true); return ka.generateSecret();
    }
    static String decrypt(JSONObject mine,JSONObject peer,String sender,String recipient,JSONObject message) throws Exception {
        byte[] bits=shared(mine,peer);
        byte[] key=hkdf(bits,bytes("fb-chat-v1|"+sender+"|"+recipient));
        Cipher c=Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE,new SecretKeySpec(key,"AES"),new GCMParameterSpec(128,decode(message.getString("iv"))));
        return new String(c.doFinal(decode(message.getString("ciphertext"))),StandardCharsets.UTF_8);
    }
    static JSONObject encrypt(JSONObject mine,JSONObject peer,String sender,String recipient,String plain) throws Exception {
        byte[] bits=shared(mine,peer);
        byte[] key=hkdf(bits,bytes("fb-chat-v1|"+sender+"|"+recipient));
        byte[] iv=new byte[12]; new java.security.SecureRandom().nextBytes(iv);
        Cipher c=Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE,new SecretKeySpec(key,"AES"),new GCMParameterSpec(128,iv));
        JSONObject out=new JSONObject(); out.put("iv",encode(iv)); out.put("ciphertext",encode(c.doFinal(bytes(plain)))); return out;
    }
    private NativeCrypto() {}
}    private static String fixed(java.math.BigInteger value) {
        byte[] raw=value.toByteArray();int start=raw.length>32&&raw[0]==0?1:0;
        byte[] out=new byte[32];int count=Math.min(32,raw.length-start);
        System.arraycopy(raw,raw.length-count,out,32-count,count);return encode(out);
    }
    static JSONObject create(String password) throws Exception {
        java.security.KeyPairGenerator generator=java.security.KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));java.security.KeyPair pair=generator.generateKeyPair();
        java.security.interfaces.ECPublicKey pub=(java.security.interfaces.ECPublicKey)pair.getPublic();
        java.security.interfaces.ECPrivateKey priv=(java.security.interfaces.ECPrivateKey)pair.getPrivate();
        JSONObject publicJwk=new JSONObject();publicJwk.put("kty","EC");publicJwk.put("crv","P-256");
        publicJwk.put("x",fixed(pub.getW().getAffineX()));publicJwk.put("y",fixed(pub.getW().getAffineY()));
        JSONObject privateJwk=new JSONObject(publicJwk.toString());privateJwk.put("d",fixed(priv.getS()));
        String fp=fingerprint(publicJwk);byte[] salt=new byte[16],iv=new byte[12];java.security.SecureRandom random=new java.security.SecureRandom();random.nextBytes(salt);random.nextBytes(iv);
        PBEKeySpec spec=new PBEKeySpec(password.toCharArray(),salt,310000,256);
        byte[] raw=SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();spec.clearPassword();
        JSONObject bundlePlain=new JSONObject();bundlePlain.put("version",1);bundlePlain.put("fingerprint",fp);bundlePlain.put("privateJwk",privateJwk);
        Cipher aes=Cipher.getInstance("AES/GCM/NoPadding");aes.init(Cipher.ENCRYPT_MODE,new SecretKeySpec(raw,"AES"),new GCMParameterSpec(128,iv));
        JSONObject backup=new JSONObject();backup.put("version",1);backup.put("iterations",310000);backup.put("salt",encode(salt));
        backup.put("iv",encode(iv));backup.put("ciphertext",encode(aes.doFinal(bytes(bundlePlain.toString()))));backup.put("fingerprint",fp);
        JSONObject result=new JSONObject();result.put("public_key",publicJwk);result.put("private_key",privateJwk);result.put("key_backup",backup);return result;
    }
