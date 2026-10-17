package dev.capabilityfabric.personalagent;

public final class TelemetryContractSelfTest {
  private static int successes=0;
  private static void ok(boolean pass,String msg){
    if(!pass)throw new AssertionError(msg); successes++;
  }
  private static void rejects(String type,String src,String phase,String error){
    boolean rejected=false;
    try{TelemetryContractV1.valid(type,src,phase,error);}
    catch(IllegalArgumentException expected){rejected=true;}
    ok(rejected,"must reject invalid telemetry enum");
  }
  private static void accepts(String type,String src,String phase,String error){
    TelemetryContractV1.valid(type,src,phase,error);
    ok(true,"valid telemetry");
  }
  public static void main(String[] args){
    accepts("APP_START","APP","IDLE","NONE");
    accepts("DIAGNOSTIC_PING","MANUAL","IDLE","NONE");
    accepts("SPEAK_READY","SPEAK","SONIOX","NONE");
    accepts("WAKE_CAPTURED","WAKE","CAPTURED","NONE");
    accepts("NETWORK_OFFLINE","NETWORK","ERROR","NETWORK");
    accepts("SYNC_ACK","JOB","ACKED","NONE");
    accepts("QUEUE_CAPTURED","TYPE","PENDING","NONE");
    rejects("UPLOAD_AUDIO","WAKE","LISTENING","NONE");
    rejects("TRANSCRIPT_SEND","SPEAK","CAPTURED","NONE");
    rejects("APP_START","transcript=my data","IDLE","NONE");
    rejects("APP_START","APP","Bearer secret","NONE");
    rejects("APP_START","APP","IDLE","my credential");
    rejects("PAIR_WITH_TOKEN","APP","IDLE","NONE");
    ok("NETWORK".equals(TelemetryContractV1.exceptionCode(new java.net.ConnectException("secret body"))),"exception sanitizes network");
    ok("TIMEOUT".equals(TelemetryContractV1.exceptionCode(new java.net.SocketTimeoutException("username"))),"timeout sanitized");
    ok("TLS".equals(TelemetryContractV1.exceptionCode(new javax.net.ssl.SSLHandshakeException("session"))),"tls sanitized");
    ok("UNKNOWN".equals(TelemetryContractV1.exceptionCode(new Exception("raw chat here"))),"unrecognized exception sanitized");
    ok("NONE".equals(TelemetryContractV1.exceptionCode(null)),"null exception maps to NONE");
    final String id="aa11bb22cc33dd44ee55ff6611223344";
    ok(TelemetryContractV1.validReply(id,42,TelemetryContractV1.RECEIPT,id,42,"RECORDED",Boolean.TRUE,Boolean.FALSE),"valid repeat receipt");
    ok(!TelemetryContractV1.validReply(id,42,TelemetryContractV1.RECEIPT,"wrong",42,"RECORDED",Boolean.FALSE,Boolean.FALSE),"reject cross-event");
    ok(!TelemetryContractV1.validReply(id,42,TelemetryContractV1.RECEIPT,id,43,"RECORDED",Boolean.FALSE,Boolean.FALSE),"reject wrong seq");
    ok(!TelemetryContractV1.validReply(id,42,"bad-schema",id,42,"RECORDED",Boolean.FALSE,Boolean.FALSE),"reject wrong schema");
    ok(!TelemetryContractV1.validReply(id,42,TelemetryContractV1.RECEIPT,id,42,"DONE",Boolean.FALSE,Boolean.FALSE),"reject false complete");
    ok(!TelemetryContractV1.validReply(id,42,TelemetryContractV1.RECEIPT,id,42,"RECORDED",Boolean.FALSE,Boolean.TRUE),"reject executed");
    ok(!TelemetryContractV1.validReply(id,42,TelemetryContractV1.RECEIPT,id,42,"RECORDED","false",Boolean.FALSE),"reject fake string bool");
    ok(TelemetryContractV1.VERSION_CODE==7,"correct version");
    ok("cf.agentos.telemetry.v1".equals(TelemetryContractV1.SCHEMA),"exact telemetry schema");
    ok(!TelemetryContractV1.TYPES.contains("ChatGPT_SEND"),"no chat effects");
    ok(!TelemetryContractV1.SOURCES.contains("audio_bytes"),"no audio source");
    System.out.println("ALPHA5_TELEMETRY_JAVA_TESTS_PASS="+successes);
  }
}
