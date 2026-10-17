package dev.capabilityfabric.personalagent;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.regex.Pattern;

public final class IngressContractV2 {
  public static final String COMMAND_SCHEMA="cf.agentos.command.v2";
  public static final String RECEIPT_SCHEMA="cf.agentos.ingress-receipt.v2";
  private static final Pattern ID=Pattern.compile("[A-Za-z0-9_-]{8,100}");
  private static final Pattern WORK=Pattern.compile("[A-Za-z0-9_-]{1,100}");
  private IngressContractV2(){}
  public static void validate(String text,String work){
    if(text==null || text.trim().isEmpty() || text.getBytes(StandardCharsets.UTF_8).length>8192)
      throw new IllegalArgumentException("INVALID_COMMAND_TEXT");
    for(int i=0;i<text.length();i++){
      char c=text.charAt(i);
      if(Character.isHighSurrogate(c)){
        if(++i==text.length() || !Character.isLowSurrogate(text.charAt(i)))
          throw new IllegalArgumentException("INVALID_UTF16");
      } else if(Character.isLowSurrogate(c))throw new IllegalArgumentException("INVALID_UTF16");
    }
    if(work!=null&&!WORK.matcher(work).matches())throw new IllegalArgumentException("INVALID_WORK");
  }
  public static String digest(String text) throws Exception{
    byte[] v=MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
    StringBuilder s=new StringBuilder(64);
    for(byte b:v)s.append(String.format(Locale.ROOT,"%02x",b&255));
    return s.toString();
  }
  public static boolean validReceipt(
      String id,String sha,String work,String schema,String replyId,String replySha,
      String replyWork,String receiptId,String state,String receipt,Object executed,Object duplicate){
    return id!=null && ID.matcher(id).matches()
      && receiptId!=null&&ID.matcher(receiptId).matches()
      && RECEIPT_SCHEMA.equals(schema)&&id.equals(replyId)
      && sha!=null&&sha.equals(replySha)
      && (work==null?replyWork==null:work.equals(replyWork))
      && "QUEUED".equals(state)&&"DURABLY_ACCEPTED".equals(receipt)
      && Boolean.FALSE.equals(executed)&&duplicate instanceof Boolean;
  }
}
