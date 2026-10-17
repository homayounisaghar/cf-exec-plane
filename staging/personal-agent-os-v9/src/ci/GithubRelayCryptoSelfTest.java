package dev.capabilityfabric.personalagent;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.util.Arrays;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.OAEPParameterSpec;
import javax.crypto.spec.PSource;
import javax.crypto.spec.SecretKeySpec;
import java.security.spec.MGF1ParameterSpec;

public final class GithubRelayCryptoSelfTest {
  private static int tests=0;
  private static void check(boolean value,String label){
    if(!value)throw new AssertionError(label);
    tests++;
  }
  private static void invalid(Runnable runnable,String description){
    boolean rejected=false;
    try{runnable.run();}catch(Exception wanted){rejected=true;}
    check(rejected,description);
  }
  private static byte[] utf(String s){return s.getBytes(StandardCharsets.UTF_8);}
  public static void main(String[] args)throws Exception{
    KeyPairGenerator kg=KeyPairGenerator.getInstance("RSA");
    kg.initialize(3072);KeyPair encryption=kg.generateKeyPair(),signing=kg.generateKeyPair();
    String publicPem=pem(encryption.getPublic().getEncoded());
    String signPem=pem(signing.getPublic().getEncoded());
    String id="0123456789abcdef0123456789abcdef";
    String inner="{\"packet_id\":\""+id+"\",\"route\":\"/v3/telemetry\",\"token\":\"synthetic_not_user_token_abcdefghijklmnopqrstuvwxyz\",\"schema\":\"cf.agentos.github-payload.v1\",\"payload\":{\"event\":\"test\"}}";
    GithubRelayCrypto.Sealed x=GithubRelayCrypto.seal(publicPem,id,utf(inner));
    check(x.wrappedKey.length()==512,"rsa3072 wraps to 384 bytes");
    check(x.nonce.length()==16,"12 byte nonce base64");
    check(x.ciphertext.length()>64,"ciphertext created");
    check(!x.ciphertext.contains("synthetic_not_user_token_abcdefghijklmnopqrstuvwxyz"),"secrets not plaintext");
    Cipher rsa=Cipher.getInstance("RSA/ECB/OAEPPadding");
    OAEPParameterSpec oaep=new OAEPParameterSpec("SHA-256","MGF1",MGF1ParameterSpec.SHA256,PSource.PSpecified.DEFAULT);
    rsa.init(Cipher.DECRYPT_MODE,encryption.getPrivate(),oaep);
    byte[] key=rsa.doFinal(GithubRelayCrypto.decode(x.wrappedKey,384,384));
    check(key.length==32,"aes256 key length");
    Cipher aes=Cipher.getInstance("AES/GCM/NoPadding");
    aes.init(Cipher.DECRYPT_MODE,new SecretKeySpec(key,"AES"),
      new GCMParameterSpec(128,GithubRelayCrypto.decode(x.nonce,12,12)));
    aes.updateAAD(utf(GithubRelayCrypto.ENVELOPE_SCHEMA+"|"+GithubRelayCrypto.KEY_ID+"|"+id));
    check(inner.equals(new String(aes.doFinal(GithubRelayCrypto.decode(x.ciphertext,16,8000)),StandardCharsets.UTF_8)),
      "roundtrip authenticated plaintext");
    check(!GithubRelayCrypto.seal(publicPem,id,utf(inner)).nonce.equals(x.nonce),"independent randomized nonce");
    Signature signer=Signature.getInstance("SHA256withRSA");
    signer.initSign(signing.getPrivate());signer.update(utf("signed receipt"));
    String sig=GithubRelayCrypto.encode(signer.sign());
    check(GithubRelayCrypto.validSignature(signPem,utf("signed receipt"),sig),"PKCS1SHA256 signature");
    check(!GithubRelayCrypto.validSignature(signPem,utf("altered signed receipt"),sig),"tampering is detected");
    check(!GithubRelayCrypto.validSignature(publicPem,utf("signed receipt"),sig),"wrong signer rejected");
    check(!GithubRelayCrypto.validSignature(signPem,utf("signed receipt"),"!?"),"bad sig encoding rejected");
    check(!GithubRelayCrypto.validSignature(signPem,new byte[9001],sig),"oversized signed body rejected");
    check(GithubRelayCrypto.ALGORITHM.equals("RSA-OAEP-SHA256+A256GCM"),"algorithm contract");
    check(GithubRelayCrypto.ENVELOPE_SCHEMA.equals("cf.agentos.github-envelope.v1"),"schema contract");
    check(GithubRelayCrypto.RECEIPT_SCHEMA.equals("cf.agentos.github-signed-receipt.v1"),"signed receipt contract");
    check(GithubRelayCrypto.decode(GithubRelayCrypto.encode(new byte[]{1,2,3}),3,3).length==3,"url base64 roundtrip");
    invalid(()->GithubRelayCrypto.decode("!!!",1,100),"base64 invalid reject");
    invalid(()->GithubRelayCrypto.decode("A",1,100),"base64 too-short reject");
    invalid(()->GithubRelayCrypto.decode("AQ==",1,100),"base64 padding reject");
    invalid(()->GithubRelayCrypto.decode("AQ",2,100),"base64 min length");
    invalid(()->{try{GithubRelayCrypto.readPublic("private-material");}catch(Exception e){throw new IllegalArgumentException(e);}},"private/public key confusion reject");
    invalid(()->{try{GithubRelayCrypto.seal(publicPem,"wrong",utf(inner));}catch(Exception e){throw new IllegalArgumentException(e);}},"wrong packet id reject");
    invalid(()->{try{GithubRelayCrypto.seal(publicPem,id,new byte[8001]);}catch(Exception e){throw new IllegalArgumentException(e);}},"oversized payload reject");
    invalid(()->{try{GithubRelayCrypto.seal(publicPem,id,new byte[0]);}catch(Exception e){throw new IllegalArgumentException(e);}},"empty payload reject");
    System.out.println("ALPHA6_GITHUB_RSA_AES_RECEIPT_TESTS_PASS="+tests);
    // Optional cross-implementation test emits only a synthetic ciphertext package.
    if(args.length==2){
      String realKey=Files.readString(Path.of(args[0]));
      GithubRelayCrypto.Sealed m=GithubRelayCrypto.seal(realKey,id,utf(inner));
      String json="{\"schema\":\""+GithubRelayCrypto.ENVELOPE_SCHEMA+"\",\"packet_id\":\""+id+
         "\",\"kid\":\""+GithubRelayCrypto.KEY_ID+"\",\"alg\":\""+GithubRelayCrypto.ALGORITHM+
         "\",\"wrapped_key\":\""+m.wrappedKey+"\",\"nonce\":\""+m.nonce+
         "\",\"ciphertext\":\""+m.ciphertext+"\"}";
      Files.writeString(Path.of(args[1]),json);
      System.out.println("ALPHA6_JAVA_TO_PYTHON_ENVELOPE_CREATED");
    }
  }
  private static String pem(byte[] encoded){
    return "-----BEGIN PUBLIC KEY-----\n"+
      Base64.getMimeEncoder(64,new byte[]{'\n'}).encodeToString(encoded)+
      "\n-----END PUBLIC KEY-----\n";
  }
}
