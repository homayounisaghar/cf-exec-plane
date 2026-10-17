package dev.capabilityfabric.personalagent;
import java.util.Locale;

/** Returns the exact source suffix for wake+command, without normalizing the payload itself. */
public final class WakeCommandExtractor {
    private WakeCommandExtractor(){}
    public static String inlineCommand(String chunk,String... aliases){
        if(chunk==null||chunk.isEmpty()||aliases==null)return "";
        String best="";int bestWakeLength=-1;
        for(String alias:aliases){
            String expected=normalize(alias);
            if(expected.isEmpty())continue;
            for(int pos=1;pos<chunk.length();pos++){
                int separator=chunk.codePointAt(pos);
                if(!boundary(separator))continue;
                if(!normalize(chunk.substring(0,pos)).equals(expected))continue;
                int start=pos;
                while(start<chunk.length() && boundary(chunk.codePointAt(start))){
                    start+=Character.charCount(chunk.codePointAt(start));
                }
                if(start>=chunk.length())continue;
                String raw=chunk.substring(start).trim();
                if(hasContent(raw)&&expected.length()>bestWakeLength){
                    bestWakeLength=expected.length();
                    best=raw;
                }
                break;
            }
        }
        return best;
    }
    private static boolean hasContent(String v) {
        for(int i=0;i<v.length();){int cp=v.codePointAt(i);if(Character.isLetterOrDigit(cp))return true;i+=Character.charCount(cp);}
        return false;
    }
    private static boolean boundary(int cp){
        if(Character.isWhitespace(cp))return true;
        switch(Character.getType(cp)){
            case Character.CONNECTOR_PUNCTUATION:
            case Character.DASH_PUNCTUATION:
            case Character.START_PUNCTUATION:
            case Character.END_PUNCTUATION:
            case Character.INITIAL_QUOTE_PUNCTUATION:
            case Character.FINAL_QUOTE_PUNCTUATION:
            case Character.OTHER_PUNCTUATION:
                return true;
            default:return false;
        }
    }
    private static String normalize(String v){
        if(v==null)return "";
        return v.replace('ي','ی').replace('ى','ی').replace('ك','ک').replace('\u200c',' ')
                .replace("ـ","").replaceAll("[ً-ٰٟ]","").trim().replaceAll("\\s+"," ")
                .toLowerCase(Locale.ROOT);
    }
}
