package com.homayounisaghar.dexasuperdashboard;

import android.Manifest;
import android.app.Activity;
import android.app.AlarmManager;
import android.app.AppOpsManager;
import android.app.NotificationManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.PermissionInfo;
import android.content.UriPermission;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.PowerManager;
import android.os.Process;
import android.provider.Settings;
import android.provider.Telephony;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.Arrays;
import java.util.List;

/** Android-owned permissions. The web UI can only request permissions declared in THIS APK
 * and explicit known special-access settings. No raw Intent, shell, or arbitrary effect bridge. */
final class PermissionGateway {
    static final int RUNTIME_REQUEST = 5122;
    static final int PICK_TREE_REQUEST = 5123;
    private final MainActivity host;
    private final Telemetry telemetry;
    private final SharedPreferences prefs;

    PermissionGateway(MainActivity host, Telemetry telemetry) {
        this.host = host;
        this.telemetry = telemetry;
        this.prefs = host.getSharedPreferences("dexa_super_permissions_v1",Context.MODE_PRIVATE);
    }

    private JSONObject response(String key, String kind, boolean declared, boolean granted, String state) {
        JSONObject o = new JSONObject();
        try {
            o.put("id", key);
            o.put("kind", kind);
            o.put("declared", declared);
            o.put("granted", granted);
            o.put("state", state);
        } catch(Exception ignored) {}
        return o;
    }

    private boolean declared(String permission) {
        try {
            PackageInfo info = host.getPackageManager().getPackageInfo(host.getPackageName(), PackageManager.GET_PERMISSIONS);
            return info.requestedPermissions != null && Arrays.asList(info.requestedPermissions).contains(permission);
        } catch (Exception e) {return false;}
    }

    private boolean dangerous(String permission) {
        try {
            PermissionInfo info=host.getPackageManager().getPermissionInfo(permission,0);
            return (info.protectionLevel & PermissionInfo.PROTECTION_MASK_BASE)==PermissionInfo.PROTECTION_DANGEROUS;
        } catch(Exception ignored) {return false;}
    }

    private boolean approvedRuntime(String key) {
        if(!key.startsWith("android.permission.") || key.length()>100) return false;
        for(int i=0;i<key.length();i++) {
            char c=key.charAt(i);
            if(!((c>='A'&&c<='Z') || (c>='a'&&c<='z') || (c>='0'&&c<='9') || c=='.'||c=='_'))return false;
        }
        return declared(key) && dangerous(key);
    }

    JSONObject status(String id) {
        if(id==null || id.length()>120)return response("", "unknown",false,false,"INVALID_ID");
        if(id.startsWith("android.permission.")) {
            boolean declared=declared(id);
            if(!declared)return response(id,"runtime",false,false,"NOT_DECLARED");
            if(!dangerous(id))return response(id,"non_runtime",true,false,"NOT_REQUESTABLE_RUNTIME");
            try {
                boolean granted=host.checkSelfPermission(id)==PackageManager.PERMISSION_GRANTED;
                return response(id,"runtime",true,granted,granted?"GRANTED":"NOT_GRANTED");
            } catch(Exception e){return response(id,"runtime",true,false,"UNAVAILABLE");}
        }
        boolean supported=true,granted=false;
        try {
            switch(id) {
                case "all_files":
                    supported=Build.VERSION.SDK_INT>=30 && declared(Manifest.permission.MANAGE_EXTERNAL_STORAGE);
                    granted=supported && Environment.isExternalStorageManager();break;
                case "overlay":
                    granted=Settings.canDrawOverlays(host);break;
                case "write_settings":
                    granted=Settings.System.canWrite(host);break;
                case "usage_access":
                    AppOpsManager ops=(AppOpsManager)host.getSystemService(Context.APP_OPS_SERVICE);
                    granted=ops!=null && ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS,Process.myUid(),host.getPackageName())==AppOpsManager.MODE_ALLOWED;
                    break;
                case "notification_listener":
                    String listeners=Settings.Secure.getString(host.getContentResolver(),"enabled_notification_listeners");
                    ComponentName listener=new ComponentName(host, NotificationAgentService.class);
                    granted=listeners!=null && (listeners.contains(listener.flattenToString()) || listeners.contains(listener.flattenToShortString()));break;
                case "accessibility":
                    String enabled=Settings.Secure.getString(host.getContentResolver(),Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
                    ComponentName svc=new ComponentName(host, AccessibilityAgentService.class);
                    granted=enabled!=null && (enabled.contains(svc.flattenToString()) || enabled.contains(svc.flattenToShortString()));break;
                case "dnd":
                    NotificationManager nm=(NotificationManager)host.getSystemService(Context.NOTIFICATION_SERVICE);
                    granted=nm!=null&&nm.isNotificationPolicyAccessGranted();break;
                case "exact_alarm":
                    supported=Build.VERSION.SDK_INT>=31;
                    AlarmManager alarm=(AlarmManager)host.getSystemService(Context.ALARM_SERVICE);
                    granted=alarm!=null && (!supported || alarm.canScheduleExactAlarms());break;
                case "install_packages":
                    supported=Build.VERSION.SDK_INT>=26;
                    granted=supported&&host.getPackageManager().canRequestPackageInstalls();break;
                case "battery_exempt":
                    PowerManager pm=(PowerManager)host.getSystemService(Context.POWER_SERVICE);
                    granted=pm!=null&&pm.isIgnoringBatteryOptimizations(host.getPackageName());break;
                case "default_sms":
                    granted=host.getPackageName().equals(Telephony.Sms.getDefaultSmsPackage(host));break;
                case "saf_tree":
                    String uri=prefs.getString("tree_uri",null);
                    granted=false;
                    if(uri!=null)for(UriPermission p:host.getContentResolver().getPersistedUriPermissions())if(uri.equals(p.getUri().toString())&&p.isReadPermission())granted=true;
                    break;
                case "background_location":
                    supported=Build.VERSION.SDK_INT>=29 && declared(Manifest.permission.ACCESS_BACKGROUND_LOCATION);
                    granted=supported&&host.checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION)==PackageManager.PERMISSION_GRANTED;
                    break;
                default:
                    return response(id,"special",false,false,"UNKNOWN_SPECIAL_ACCESS");
            }
        } catch(Exception e){return response(id,"special",supported,false,"CHECK_FAILED");}
        return response(id,"special",supported,granted,!supported?"UNAVAILABLE":granted?"GRANTED":"NOT_GRANTED");
    }

    JSONObject request(String id) {
        JSONObject pre=status(id);
        final String state=pre.optString("state","UNKNOWN");
        if("NOT_DECLARED".equals(state)||"NOT_REQUESTABLE_RUNTIME".equals(state)||"UNKNOWN_SPECIAL_ACCESS".equals(state)||"UNAVAILABLE".equals(state))return result(id,false,state);
        if(pre.optBoolean("granted"))return result(id,true,"ALREADY_GRANTED");
        if(id.startsWith("android.permission.")) {
            if(!approvedRuntime(id))return result(id,false,"NOT_REQUESTABLE");
            // Background location and background body sensor grants follow platform-specific settings paths.
            if(id.equals(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                || id.equals("android.permission.BODY_SENSORS_BACKGROUND")) {
                return openSettings(id, Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:"+host.getPackageName()));
            }
            telemetry.record("PERMISSION_REQUEST",-1,Telemetry.meta("code",id.replace("android.permission.","")));
            host.requestPermissions(new String[]{id},RUNTIME_REQUEST);
            return result(id,true,"ANDROID_PROMPT_SHOWN");
        }
        if(id.equals("saf_tree")) {
            try {
                Intent pick=new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
                pick.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                host.startActivityForResult(pick,PICK_TREE_REQUEST);
                telemetry.record("SPECIAL_ACCESS_REQUEST",-1,Telemetry.meta("code",id));
                return result(id,true,"ANDROID_FILE_PICKER_SHOWN");
            } catch(Exception e){return result(id,false,"PICKER_UNAVAILABLE");}
        }
        String action;
        Uri uri=null;
        switch(id) {
            case "all_files":action=Build.VERSION.SDK_INT>=30?Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION:Settings.ACTION_APPLICATION_DETAILS_SETTINGS;uri=Uri.parse("package:"+host.getPackageName());break;
            case "overlay":action=Settings.ACTION_MANAGE_OVERLAY_PERMISSION;uri=Uri.parse("package:"+host.getPackageName());break;
            case "write_settings":action=Settings.ACTION_MANAGE_WRITE_SETTINGS;uri=Uri.parse("package:"+host.getPackageName());break;
            case "usage_access":action=Settings.ACTION_USAGE_ACCESS_SETTINGS;break;
            case "notification_listener":action=Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS;break;
            case "accessibility":action=Settings.ACTION_ACCESSIBILITY_SETTINGS;break;
            case "dnd":action=Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS;break;
            case "exact_alarm":action=Build.VERSION.SDK_INT>=31?Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM:Settings.ACTION_APPLICATION_DETAILS_SETTINGS;uri=Uri.parse("package:"+host.getPackageName());break;
            case "install_packages":action=Build.VERSION.SDK_INT>=26?Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES:Settings.ACTION_APPLICATION_DETAILS_SETTINGS;uri=Uri.parse("package:"+host.getPackageName());break;
            case "battery_exempt":action=Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS;break;
            case "default_sms":action=Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS;break;
            case "background_location":action=Settings.ACTION_APPLICATION_DETAILS_SETTINGS;uri=Uri.parse("package:"+host.getPackageName());break;
            default:return result(id,false,"UNKNOWN_SPECIAL_ACCESS");
        }
        return openSettings(id,action,uri);
    }

    private JSONObject openSettings(String id,String action,Uri uri) {
        try {
            Intent launch=new Intent(action);
            if(uri!=null)launch.setData(uri);
            host.startActivity(launch);
            telemetry.record("SPECIAL_ACCESS_REQUEST",-1,Telemetry.meta("code",id));
            return result(id,true,"ANDROID_SETTINGS_OPENED");
        } catch(Exception e) {
            try {
                Intent fallback=new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:"+host.getPackageName()));
                host.startActivity(fallback);
                telemetry.record("SPECIAL_ACCESS_FALLBACK",-1,Telemetry.meta("code",id));
                return result(id,true,"APP_SETTINGS_OPENED");
            }catch(Exception fail){return result(id,false,"SETTINGS_UNAVAILABLE");}
        }
    }

    private JSONObject result(String id,boolean ok,String code) {
        JSONObject o = new JSONObject();
        try{o.put("ok",ok);o.put("code",code);o.put("permission",status(id));}catch(Exception ignored){}
        return o;
    }

    boolean onPermissionResult(int requestCode,String[] permissions,int[] results) {
        if(requestCode!=RUNTIME_REQUEST)return false;
        for(int i=0;i<permissions.length;i++){
            String id=permissions[i].replace("android.permission.","");
            boolean approved=i<results.length && results[i]==PackageManager.PERMISSION_GRANTED;
            telemetry.record("PERMISSION_RESULT",-1,Telemetry.meta("code",id,"ok",approved));
        }
        return true;
    }

    boolean onActivityResult(int requestCode,int resultCode,Intent data) {
        if(requestCode!=PICK_TREE_REQUEST)return false;
        boolean ok=false;
        if(resultCode==Activity.RESULT_OK&&data!=null&&data.getData()!=null){
            Uri uri=data.getData();
            try{
                int flags=data.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                if((flags&Intent.FLAG_GRANT_READ_URI_PERMISSION)!=0)host.getContentResolver().takePersistableUriPermission(uri,flags);
                prefs.edit().putString("tree_uri",uri.toString()).apply();
                ok=true;
            }catch(Exception ignored){}
        }
        telemetry.record("SAF_GRANT_RESULT",-1,Telemetry.meta("ok",ok));
        return true;
    }
}
