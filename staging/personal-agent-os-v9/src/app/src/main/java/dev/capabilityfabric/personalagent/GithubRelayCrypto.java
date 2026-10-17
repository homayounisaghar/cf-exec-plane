package dev.capabilityfabric.personalagent;

import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.spec.MGF1ParameterSpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.OAEPParameterSpec;
import javax.crypto.spec.PSource;
import javax.crypto.spec.SecretKeySpec;

/** JCA-only core shared by Android and independent JVM protocol test. */
public final class GithubRelayCrypto {
  public static final String ENVELOPE_SCHEMA="cf.agentos.github-envelope.v1";
  public static final String PAYLOAD_SCHEMA="cf.agentos.github-payload.v1";
  public static final String RECEIPT_SCHEMA="cf.agentos.github-signed-receipt.v1";
  public static final String KEY_ID="github-relay-rsa3072-v1";
  public static final String ALGORITHM="RSA-OAEP-SHA256+A256GCM";
  private static final SecureRandom RANDOM=new SecureRandom();
  private GithubRelayCrypto(){}
  public static final class Sealed{
    public final String wrappedKey,nonce,ciphertext;
    public Sealed(String wrappedKey,String nonce,String ciphertext){
      this.wrappedKey=wrappedKey;this.nonce=nonce;this.ciphertext=ciphertext;
    }
  }
  public static String encode(byte[] bytes){
    return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
  }
  public static byte[] decode(String text,int min,int max){
    if(text==null||!text.matches("[A-Za-z0-9_-]{1,20000}"))
      throw new IllegalArgumentException("INVALID_BASE64");
    byte[] data=Base64.getUrlDecoder().decode(text);
    if(data.length<min||data.length>max||!encode(data).equals(text))
      throw new IllegalArgumentException("INVALID_BASE64_BYTES");
    return data;
  }
  public static PublicKey readPublic(String pem)throws Exception{
    if(pem==null || !pem.startsWith("-----BEGIN PUBLIC KEY-----"))throw new IllegalArgumentException("PUBLIC_KEY_FORMAT");
    String stripped=pem.replace("-----BEGIN PUBLIC KEY-----","")
       .replace("-----END PUBLIC KEY-----","").replaceAll("\\s+","");
    byte[] encoded=Base64.getDecoder().decode(stripped);
    PublicKey key=KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(encoded));
    if(!"RSA".equals(key.getAlgorithm()) || encoded.length<410||encoded.length>500)
      throw new IllegalArgumentException("PUBLIC_KEY_SIZE");
    return key;
  }
  public static Sealed seal(String pem,String packetId,byte[] utf8Plain)throws Exception{
    if(packetId==null||!packetId.matches("[0-9a-f]{32}"))throw new IllegalArgumentException("PACKET_ID");
    if(utf8Plain==null||utf8Plain.length==0||utf8Plain.length>8000)
      throw new IllegalArgumentException("PLAINTEXT_LIMIT");
    byte[] key=new byte[32],nonce=new byte[12];
    RANDOM.nextBytes(key);RANDOM.nextBytes(nonce);
    byte[] aad=(ENVELOPE_SCHEMA+"|"+KEY_ID+"|"+packetId).getBytes(StandardCharsets.US_ASCII);
    Cipher aes=Cipher.getInstance("AES/GCM/NoPadding");
    aes.init(Cipher.ENCRYPT_MODE,new SecretKeySpec(key,"AES"),new GCMParameterSpec(128,nonce));
    aes.updateAAD(aad);
    byte[] crypt=aes.doFinal(utf8Plain);
    // Android's default MGF1 digest can be SHA1 even when OAEP's digest is SHA256.
    // Explicitly pin both to SHA256 to match Python cryptography OAEP-SHA256.
    OAEPParameterSpec spec=new OAEPParameterSpec("SHA-256","MGF1",MGF1ParameterSpec.SHA256,PSource.PSpecified.DEFAULT);
    Cipher rsa=Cipher.getInstance("RSA/ECB/OAEPPadding");
    rsa.init(Cipher.ENCRYPT_MODE,readPublic(pem),spec);
    byte[] wrapped=rsa.doFinal(key);
    return new Sealed(encode(wrapped),encode(nonce),encode(crypt));
  }
  public static boolean validSignature(String signingPem,byte[] canonicalBody,String encodedSignature){
    try{
      if(canonicalBody==null||canonicalBody.length>9000)return false;
      Signature sig=Signature.getInstance("SHA256withRSA");
      sig.initVerify(readPublic(signingPem));
      sig.update(canonicalBody);
      return sig.verify(decode(encodedSignature,384,384));
    }catch(Exception rejected){return false;}
  }
}
