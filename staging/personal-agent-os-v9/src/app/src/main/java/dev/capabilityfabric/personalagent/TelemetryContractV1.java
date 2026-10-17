package dev.capabilityfabric.personalagent;

import java.util.Set;
import java.util.Collections;
import java.util.HashSet;
import java.util.Arrays;

/** Strict telemetry vocabulary: no raw text, audio, URLs, tokens or arbitrary errors. */
public final class TelemetryContractV1 {
  public static final String SCHEMA="cf.agentos.telemetry.v1";
  public static final String RECEIPT="cf.agentos.telemetry-receipt.v1";
  public static final int VERSION_CODE=7;
  public static final Set<String> TYPES=Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
    "APP_START","APP_RESUME","APP_PAUSE","SPEAK_OPEN","SPEAK_START","SPEAK_READY",
    "SPEAK_CAPTURED","SPEAK_ERROR","WAKE_OPEN","WAKE_START","WAKE_READY",
    "WAKE_PHASE","WAKE_CAPTURED","WAKE_STOP","WAKE_ERROR","QUEUE_CAPTURED",
    "QUEUE_ERROR","SYNC_BEGIN","SYNC_ACK","SYNC_ERROR","NETWORK_OFFLINE",
    "NETWORK_RESTORED","DIAGNOSTIC_PING","DIAGNOSTIC_ENABLED",
    "DIAGNOSTIC_PAUSED","PAIR_SUCCESS")));
  public static final Set<String> SOURCES=Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
    "APP","SPEAK","WAKE","TYPE","JOB","MANUAL","SYSTEM","NETWORK")));
  public static final Set<String> PHASES=Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
    "IDLE","LISTENING","WAIT_COMMAND","AUTH","SONIOX","CAPTURED",
    "STOPPED","ERROR","PENDING","ACKED")));
  public static final Set<String> NETWORKS=Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
    "NONE","WIFI","CELLULAR","OTHER","UNKNOWN")));
  public static final Set<String> ERRORS=Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
    "NONE","NETWORK","TIMEOUT","TLS","HTTP","PERMISSION",
    "STORE","AUDIO","STT","AUTH","UNKNOWN")));
  private TelemetryContractV1(){}
  public static void valid(String type,String source,String phase,String error){
    if(!TYPES.contains(type)||!SOURCES.contains(source)||
       !PHASES.contains(phase)||!ERRORS.contains(error))
      throw new IllegalArgumentException("TELEMETRY_ENUM_REJECTED");
  }
  public static String exceptionCode(Throwable e){
    if(e==null)return "NONE";
    String name=e.getClass().getSimpleName();
    if(name.contains("Timeout"))return "TIMEOUT";
    if(name.contains("SSL")||name.contains("Certificate"))return "TLS";
    if(name.contains("Connect")||name.contains("Socket")||
       name.contains("UnknownHost"))return "NETWORK";
    if(name.contains("Security")||name.contains("Permission"))return "PERMISSION";
    if(name.contains("SQLite"))return "STORE";
    return "UNKNOWN";
  }
  public static boolean validReply(String sentId,long sentSeq,String schema,
    String replyId,long replySeq,String state,Object duplicate,Object executed){
    return RECEIPT.equals(schema)&&sentId!=null&&sentId.equals(replyId)
      &&sentSeq==replySeq&&"RECORDED".equals(state)
      &&duplicate instanceof Boolean&&Boolean.FALSE.equals(executed);
  }
}
