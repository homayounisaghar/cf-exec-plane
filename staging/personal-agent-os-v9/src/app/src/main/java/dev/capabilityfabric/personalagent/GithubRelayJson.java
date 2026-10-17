package dev.capabilityfabric.personalagent;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;

/** Byte-for-byte JSON canonicalization compatible with Python json.dumps(sort_keys=True,separators=(',',':'),ensure_ascii=False).
  * VPS-issued receipt contains only ASCII enum/identifiers; do not use floats. */
public final class GithubRelayJson {
  private GithubRelayJson(){}
  public static String canonical(Object value) throws Exception{
    if(value==null||value==JSONObject.NULL)return "null";
    if(value instanceof JSONObject){
      JSONObject object=(JSONObject)value;
      ArrayList<String> keys=new ArrayList<>();
      Iterator<String> it=object.keys();
      while(it.hasNext())keys.add(it.next());
      Collections.sort(keys);
      StringBuilder result=new StringBuilder("{");
      for(String key:keys){
        if(result.length()>1)result.append(",");
        result.append(quote(key)).append(":").append(canonical(object.get(key)));
      }
      return result.append("}").toString();
    }
    if(value instanceof JSONArray){
      JSONArray a=(JSONArray)value;StringBuilder out=new StringBuilder("[");
      for(int i=0;i<a.length();i++){
        if(i!=0)out.append(",");
        out.append(canonical(a.get(i)));
      }
      return out.append("]").toString();
    }
    if(value instanceof String)return quote((String)value);
    if(value instanceof Boolean)return Boolean.TRUE.equals(value)?"true":"false";
    if(value instanceof Integer||value instanceof Long)return value.toString();
    throw new IllegalArgumentException("UNSUPPORTED_CANONICAL_VALUE");
  }
  private static String quote(String source){
    StringBuilder sb=new StringBuilder("\"");
    for(int i=0;i<source.length();i++){
      char c=source.charAt(i);
      switch(c){
        case '"':sb.append("\\\"");break;
        case '\\':sb.append("\\\\");break;
        case '\b':sb.append("\\b");break;
        case '\f':sb.append("\\f");break;
        case '\n':sb.append("\\n");break;
        case '\r':sb.append("\\r");break;
        case '\t':sb.append("\\t");break;
        default:
          if(c<0x20){String h=Integer.toHexString(c);sb.append("\\u");
            for(int j=h.length();j<4;j++)sb.append("0");
            sb.append(h);
          }else sb.append(c);
      }
    }
    return sb.append("\"").toString();
  }
}
