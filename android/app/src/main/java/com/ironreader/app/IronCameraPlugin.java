package com.ironreader.app;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.provider.MediaStore;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;

/**
 * IronCamera: the app's own camera (automatic validated settings), launching the phone's camera app
 * (manual route), a camera capabilities report, and crash reports from the previous run.
 * Errors are RESOLVED as {status:"error", error:{code,message,...}} so the app can always show them.
 */
@CapacitorPlugin(name = "IronCamera", permissions = { @Permission(strings = { Manifest.permission.CAMERA }, alias = "camera") })
public class IronCameraPlugin extends Plugin {

    @Override
    public void load() {
        try {
            IronCameraSupport.installCrashHandler(getContext());
        } catch (Throwable ignored) {
            // diagnostics only
        }
    }

    private static JSObject errorObj(String code, String message, Throwable t) {
        JSObject e = new JSObject();
        e.put("code", code);
        e.put("message", message);
        if (t != null) {
            e.put("exception", t.toString());
            e.put("stack", IronCameraSupport.stackOf(t, 8));
        }
        try {
            e.put("device", new JSObject(IronCameraSupport.deviceInfo().toString()));
            e.put("log", IronCameraSupport.logTail(25));
        } catch (Throwable ignored) {
            // best effort
        }
        return e;
    }

    private static void resolveError(PluginCall call, String code, String message, Throwable t) {
        IronCameraSupport.log("ERROR " + code + ": " + message + (t != null ? " / " + t : ""));
        JSObject r = new JSObject();
        r.put("status", "error");
        r.put("error", errorObj(code, message, t));
        call.resolve(r);
    }

    @PluginMethod
    public void ping(PluginCall call) {
        JSObject r = new JSObject();
        r.put("ok", true);
        r.put("native_version", IronCameraSupport.NATIVE_VERSION);
        call.resolve(r);
    }

    @PluginMethod
    public void getCapabilities(PluginCall call) {
        try {
            JSObject r = new JSObject(IronCameraSupport.capabilities(getContext()).toString());
            r.put("status", "ok");
            call.resolve(r);
        } catch (Throwable t) {
            resolveError(call, "E-CAPS", "Could not read the camera capabilities", t);
        }
    }

    // ---------------------------------------------------------------- automatic: the app's own camera
    @PluginMethod
    public void capture(PluginCall call) {
        try {
            if (getPermissionState("camera") != PermissionState.GRANTED) {
                requestPermissionForAlias("camera", call, "cameraPermissionCallback");
                return;
            }
            launchCamera(call);
        } catch (Throwable t) {
            resolveError(call, "E-CAM-LAUNCH", "Could not start the camera", t);
        }
    }

    @PermissionCallback
    private void cameraPermissionCallback(PluginCall call) {
        if (getPermissionState("camera") == PermissionState.GRANTED) {
            launchCamera(call);
        } else {
            resolveError(call, "E-CAM-PERM",
                    "Camera permission was denied. Allow it in Android Settings → Apps → Iron Reader → Permissions → Camera.", null);
        }
    }

    private void launchCamera(PluginCall call) {
        try {
            IronCameraSupport.clearLog();
            IronCameraSupport.log("capture requested " + call.getData().toString());
            Intent i = new Intent(getContext(), IronCameraActivity.class);
            i.putExtra(IronCameraActivity.EXTRA_OPTIONS, call.getData().toString());
            startActivityForResult(call, i, "captureResult");
        } catch (Throwable t) {
            resolveError(call, "E-CAM-LAUNCH", "Could not open the camera screen", t);
        }
    }

    @ActivityCallback
    private void captureResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        try {
            Intent data = result.getData();
            if (data != null && data.hasExtra(IronCameraActivity.EXTRA_RESULT)) {
                JSObject r = new JSObject(data.getStringExtra(IronCameraActivity.EXTRA_RESULT));
                r.put("status", "ok");
                call.resolve(r);
            } else if (data != null && data.hasExtra(IronCameraActivity.EXTRA_ERROR)) {
                JSObject r = new JSObject();
                r.put("status", "error");
                r.put("error", new JSObject(data.getStringExtra(IronCameraActivity.EXTRA_ERROR)));
                call.resolve(r);
            } else {
                JSObject r = new JSObject();
                r.put("status", "cancelled");
                r.put("result_code", result.getResultCode());
                call.resolve(r);
            }
        } catch (Throwable t) {
            resolveError(call, "E-CAM-RESULT", "The camera returned a result the app could not read", t);
        }
    }

    // ---------------------------------------------------------------- manual: the phone's own camera app (with Pro mode)
    @PluginMethod
    public void openCameraApp(PluginCall call) {
        try {
            Intent i = new Intent(MediaStore.INTENT_ACTION_STILL_IMAGE_CAMERA);
            getActivity().startActivity(i);
            JSObject r = new JSObject();
            r.put("status", "ok");
            call.resolve(r);
        } catch (ActivityNotFoundException e) {
            resolveError(call, "E-APP-NONE", "No camera app was found that can be opened this way", e);
        } catch (Throwable t) {
            resolveError(call, "E-APP-OPEN", "Could not open the phone's camera app", t);
        }
    }

    // ---------------------------------------------------------------- diagnostics
    @PluginMethod
    public void getLastCrash(PluginCall call) {
        JSObject r = new JSObject();
        try {
            File f = IronCameraSupport.crashFile(getContext());
            if (f.exists()) {
                r.put("crash", new String(readAll(f), "UTF-8"));
                f.delete();
            }
        } catch (Throwable t) {
            r.put("read_error", t.toString());
        }
        call.resolve(r);
    }

    /** Fallback transfer of the captured photo when the WebView can't fetch the file URL. Only files we wrote. */
    @PluginMethod
    public void readCapture(PluginCall call) {
        try {
            String path = call.getString("path");
            File dir = new File(getContext().getCacheDir(), "iron_capture");
            File f = path == null ? null : new File(path);
            if (f == null || !f.getCanonicalPath().startsWith(dir.getCanonicalPath() + File.separator) || !f.exists()) {
                resolveError(call, "E-READ-PATH", "The captured photo file was not found", null);
                return;
            }
            JSObject r = new JSObject();
            r.put("status", "ok");
            r.put("base64", Base64.encodeToString(readAll(f), Base64.NO_WRAP));
            call.resolve(r);
        } catch (Throwable t) {
            resolveError(call, "E-READ", "Could not read the captured photo", t);
        }
    }

    private static byte[] readAll(File f) throws java.io.IOException {
        InputStream in = new FileInputStream(f);
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        } finally {
            in.close();
        }
    }
}
