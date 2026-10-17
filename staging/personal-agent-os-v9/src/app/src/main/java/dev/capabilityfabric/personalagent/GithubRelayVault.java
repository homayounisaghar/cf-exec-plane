package dev.capabilityfabric.personalagent;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Phone-only fine-grained PAT: never serialized in an APK, Issue, or Android backup. */
public final class GithubRelayVault {
  private static final String PREFS="agentos_github_token_v1";
  private static final String KEY="agentos_github_issue_token_aes256_v1";
  private static final String VALUE="encrypted";
  private static final String IV="nonce";
  private static final String ENABLED="enabled";
  private static final String TESTED="server_receipt_verified";
  private static final String BACKGROUND="personal_command_backup_opt_in";
  private GithubRelayVault(){}
  private static SecretKey key(boolean create)throws Exception{
    KeyStore store=KeyStore.getInstance("AndroidKeyStore");
    store.load(null);
    KeyStore.Entry e=store.getEntry(KEY,null);
    if(e instanceof KeyStore.SecretKeyEntry)return ((KeyStore.SecretKeyEntry)e).getSecretKey();
    if(!create)throw new IllegalStateException("VAULT_KEY_MISSING");
    KeyGenerator generator=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
    generator.init(new KeyGenParameterSpec.Builder(KEY,
      KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT)
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256).setUserAuthenticationRequired(false).build());
    return generator.generateKey();
  }
  public static boolean configured(Context ctx){
    SharedPreferences p=ctx.getSharedPreferences(PREFS,Context.MODE_PRIVATE);
    return p.contains(VALUE)&&p.contains(IV);
  }
  public static boolean enabled(Context ctx){
    return configured(ctx)&&ctx.getSharedPreferences(PREFS,Context.MODE_PRIVATE).getBoolean(ENABLED,false);
  }
  public static boolean verified(Context ctx){
    return enabled(ctx)&&ctx.getSharedPreferences(PREFS,Context.MODE_PRIVATE).getBoolean(TESTED,false);
  }
  public static boolean backgroundAllowed(Context ctx){
    return verified(ctx)&&ctx.getSharedPreferences(PREFS,Context.MODE_PRIVATE)
      .getBoolean(BACKGROUND,false);
  }
  public static boolean setBackgroundAllowed(Context ctx,boolean allowed){
    if(allowed&&!verified(ctx))return false;
    return ctx.getSharedPreferences(PREFS,Context.MODE_PRIVATE).edit()
      .putBoolean(BACKGROUND,allowed).commit();
  }
  public static void store(Context ctx,String candidate)throws Exception{
    if(candidate==null||candidate.length()<45||candidate.length()>300||
       !candidate.matches("github_pat_[A-Za-z0-9_]+"))
      throw new IllegalArgumentException("ONLY_FINE_GRAINED_PAT");
    Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.ENCRYPT_MODE,key(true));
    byte[] cipherBytes=cipher.doFinal(candidate.getBytes(StandardCharsets.UTF_8));
    String encrypted=Base64.getEncoder().encodeToString(cipherBytes);
    String iv=Base64.getEncoder().encodeToString(cipher.getIV());
    if(!ctx.getSharedPreferences(PREFS,Context.MODE_PRIVATE).edit()
      .putString(VALUE,encrypted).putString(IV,iv).putBoolean(ENABLED,false)
      .putBoolean(TESTED,false).putBoolean(BACKGROUND,false).commit())
      throw new IllegalStateException("SECURE_TOKEN_SAVE_FAILED");
  }
  public static String load(Context ctx)throws Exception{
    SharedPreferences p=ctx.getSharedPreferences(PREFS,Context.MODE_PRIVATE);
    if(!configured(ctx))throw new IllegalStateException("PHONE_PAT_NOT_CONFIGURED");
    byte[] iv=Base64.getDecoder().decode(p.getString(IV,""));
    byte[] ciphertext=Base64.getDecoder().decode(p.getString(VALUE,""));
    if(iv.length!=12||ciphertext.length>512)throw new IllegalStateException("CREDENTIAL_STORE_CORRUPTED");
    Cipher aes=Cipher.getInstance("AES/GCM/NoPadding");
    aes.init(Cipher.DECRYPT_MODE,key(false),new GCMParameterSpec(128,iv));
    String token=new String(aes.doFinal(ciphertext),StandardCharsets.UTF_8);
    if(!token.matches("github_pat_[A-Za-z0-9_]{35,290}"))
      throw new IllegalStateException("CREDENTIAL_STORE_INVALID");
    return token;
  }
  public static boolean setEnabled(Context c,boolean value){
    if(value&&!configured(c))return false;
    return c.getSharedPreferences(PREFS,Context.MODE_PRIVATE).edit().putBoolean(ENABLED,value).commit();
  }
  public static boolean setVerified(Context c){
    return enabled(c)&&c.getSharedPreferences(PREFS,Context.MODE_PRIVATE)
      .edit().putBoolean(TESTED,true).commit();
  }
  public static void clear(Context c)throws Exception{
    if(!c.getSharedPreferences(PREFS,Context.MODE_PRIVATE).edit().clear().commit())
      throw new IllegalStateException("CLEAR_PAT_FAILED");
    KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);
    if(store.containsAlias(KEY))store.deleteEntry(KEY);
  }
}
