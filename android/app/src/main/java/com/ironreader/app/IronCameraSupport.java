package com.ironreader.app;

import android.content.Context;
import android.graphics.ImageFormat;
import android.graphics.SurfaceTexture;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CameraMetadata;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.os.Build;
import android.util.Range;
import android.util.Size;
import android.util.SizeF;
import java.io.File;
import java.io.FileOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Shared helpers for the in-app camera: diagnostic log, device info, camera selection,
 * the "automatic settings" plan, and the capabilities report shown in the app.
 */
final class IronCameraSupport {

    /** Bump when the native camera code changes (shown in error reports). */
    static final int NATIVE_VERSION = 2;

    private IronCameraSupport() {}

    // ------------------------------------------------------------------ diagnostic log (ring buffer)
    private static final ArrayList<String> LOG = new ArrayList<String>();

    static synchronized void log(String msg) {
        String t = new SimpleDateFormat("HH:mm:ss.SSS", Locale.US).format(new Date());
        LOG.add(t + " " + msg);
        while (LOG.size() > 80) LOG.remove(0);
        android.util.Log.i("IronCamera", msg);
    }

    static synchronized JSONArray logTail(int n) {
        JSONArray a = new JSONArray();
        for (int i = Math.max(0, LOG.size() - n); i < LOG.size(); i++) a.put(LOG.get(i));
        return a;
    }

    static synchronized String logText(int n) {
        StringBuilder sb = new StringBuilder();
        for (int i = Math.max(0, LOG.size() - n); i < LOG.size(); i++) sb.append(LOG.get(i)).append('\n');
        return sb.toString();
    }

    static synchronized void clearLog() {
        LOG.clear();
    }

    static String stackOf(Throwable t, int maxLines) {
        StringWriter sw = new StringWriter();
        t.printStackTrace(new PrintWriter(sw));
        String[] lines = sw.toString().split("\n");
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < lines.length && i < maxLines; i++) sb.append(lines[i].trim()).append('\n');
        return sb.toString();
    }

    static JSONObject deviceInfo() {
        JSONObject d = new JSONObject();
        try {
            d.put("manufacturer", Build.MANUFACTURER);
            d.put("brand", Build.BRAND);
            d.put("model", Build.MODEL);
            d.put("device", Build.DEVICE);
            d.put("android", Build.VERSION.RELEASE);
            d.put("sdk", Build.VERSION.SDK_INT);
            d.put("native_version", NATIVE_VERSION);
        } catch (JSONException ignored) {
            // never fails for these types
        }
        return d;
    }

    // ------------------------------------------------------------------ crash capture (shown in the app on next start)
    static File crashFile(Context ctx) {
        return new File(ctx.getFilesDir(), "iron_last_crash.txt");
    }

    static void installCrashHandler(Context ctx) {
        Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        if (prev instanceof CrashHandler) return;
        Thread.setDefaultUncaughtExceptionHandler(new CrashHandler(ctx.getApplicationContext(), prev));
    }

    static final class CrashHandler implements Thread.UncaughtExceptionHandler {
        private final Context app;
        private final Thread.UncaughtExceptionHandler prev;

        CrashHandler(Context app, Thread.UncaughtExceptionHandler prev) {
            this.app = app;
            this.prev = prev;
        }

        @Override
        public void uncaughtException(Thread thread, Throwable e) {
            try {
                StringBuilder sb = new StringBuilder();
                sb.append("time: ").append(new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(new Date())).append('\n');
                sb.append("thread: ").append(thread.getName()).append('\n');
                sb.append("device: ").append(deviceInfo().toString()).append('\n');
                sb.append("error: ").append(e.toString()).append('\n');
                sb.append(stackOf(e, 18));
                sb.append("--- camera log ---\n").append(logText(20));
                FileOutputStream fos = new FileOutputStream(crashFile(app));
                fos.write(sb.toString().getBytes("UTF-8"));
                fos.close();
            } catch (Throwable ignored) {
                // nothing more we can do
            }
            if (prev != null) prev.uncaughtException(thread, e);
        }
    }

    // ------------------------------------------------------------------ camera helpers
    static boolean contains(int[] arr, int v) {
        if (arr == null) return false;
        for (int x : arr) if (x == v) return true;
        return false;
    }

    static boolean hasCap(CameraCharacteristics c, int cap) {
        return contains(c.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES), cap);
    }

    static String hwLevelName(Integer l) {
        if (l == null) return "unknown";
        switch (l) {
            case CameraMetadata.INFO_SUPPORTED_HARDWARE_LEVEL_LEGACY: return "LEGACY";
            case CameraMetadata.INFO_SUPPORTED_HARDWARE_LEVEL_LIMITED: return "LIMITED";
            case CameraMetadata.INFO_SUPPORTED_HARDWARE_LEVEL_FULL: return "FULL";
            case 3: return "LEVEL_3";
            case 4: return "EXTERNAL";
            default: return "level_" + l;
        }
    }

    static String awbName(int m) {
        switch (m) {
            case CameraMetadata.CONTROL_AWB_MODE_OFF: return "off";
            case CameraMetadata.CONTROL_AWB_MODE_AUTO: return "auto";
            case CameraMetadata.CONTROL_AWB_MODE_INCANDESCENT: return "incandescent";
            case CameraMetadata.CONTROL_AWB_MODE_FLUORESCENT: return "fluorescent";
            case CameraMetadata.CONTROL_AWB_MODE_WARM_FLUORESCENT: return "warm_fluorescent";
            case CameraMetadata.CONTROL_AWB_MODE_DAYLIGHT: return "daylight";
            case CameraMetadata.CONTROL_AWB_MODE_CLOUDY_DAYLIGHT: return "cloudy";
            case CameraMetadata.CONTROL_AWB_MODE_TWILIGHT: return "twilight";
            case CameraMetadata.CONTROL_AWB_MODE_SHADE: return "shade";
            default: return "awb_" + m;
        }
    }

    static int awbFromName(String n) {
        if (n == null) return -1;
        String s = n.toLowerCase(Locale.US);
        if (s.equals("daylight")) return CameraMetadata.CONTROL_AWB_MODE_DAYLIGHT;
        if (s.equals("cloudy")) return CameraMetadata.CONTROL_AWB_MODE_CLOUDY_DAYLIGHT;
        if (s.equals("fluorescent")) return CameraMetadata.CONTROL_AWB_MODE_FLUORESCENT;
        if (s.equals("warm_fluorescent")) return CameraMetadata.CONTROL_AWB_MODE_WARM_FLUORESCENT;
        if (s.equals("incandescent")) return CameraMetadata.CONTROL_AWB_MODE_INCANDESCENT;
        if (s.equals("shade")) return CameraMetadata.CONTROL_AWB_MODE_SHADE;
        return -1;
    }

    /** 35 mm-equivalent focal length of the camera's first lens, or -1 when the camera doesn't report it. */
    static double focal35(CameraCharacteristics c) {
        float[] f = c.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS);
        SizeF s = c.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE);
        if (f == null || f.length == 0 || s == null || s.getWidth() <= 0 || s.getHeight() <= 0) return -1;
        double diag = Math.sqrt(s.getWidth() * s.getWidth() + s.getHeight() * s.getHeight());
        return f[0] * 43.27 / diag;
    }

    /** Main back camera: the back camera whose lens is closest to a normal ~26 mm-equivalent; first back camera otherwise. */
    static String chooseBackCamera(CameraManager m) throws CameraAccessException {
        String first = null, best = null;
        double bestDiff = Double.MAX_VALUE;
        boolean allKnown = true;
        for (String id : m.getCameraIdList()) {
            CameraCharacteristics c = m.getCameraCharacteristics(id);
            Integer facing = c.get(CameraCharacteristics.LENS_FACING);
            if (facing == null || facing != CameraMetadata.LENS_FACING_BACK) continue;
            if (!hasCap(c, CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_BACKWARD_COMPATIBLE)) continue;
            if (first == null) first = id;
            double f = focal35(c);
            if (f <= 0) { allKnown = false; continue; }
            double d = Math.abs(f - 26.0);
            if (d < bestDiff) { bestDiff = d; best = id; }
        }
        if (!allKnown || best == null) return first;
        return best;
    }

    static boolean is43(Size s) {
        int w = Math.max(s.getWidth(), s.getHeight()), h = Math.min(s.getWidth(), s.getHeight());
        return Math.abs(w * 3 - h * 4) <= Math.max(2, h / 50);
    }

    static Size chooseJpegSize(StreamConfigurationMap map, int targetWidth) {
        Size[] all = map.getOutputSizes(ImageFormat.JPEG);
        if (all == null || all.length == 0) return null;
        Size best = null;
        for (Size s : all) {
            if (!is43(s) || s.getWidth() < s.getHeight()) continue;
            if (best == null) { best = s; continue; }
            int d = Math.abs(s.getWidth() - targetWidth), bd = Math.abs(best.getWidth() - targetWidth);
            if (d < bd || (d == bd && s.getWidth() > best.getWidth())) best = s;
        }
        if (best != null) return best;
        for (Size s : all) if (best == null || (long) s.getWidth() * s.getHeight() > (long) best.getWidth() * best.getHeight()) best = s;
        return best;
    }

    static Size choosePreviewSize(StreamConfigurationMap map) {
        Size[] all = map.getOutputSizes(SurfaceTexture.class);
        if (all == null || all.length == 0) return new Size(640, 480);
        Size best = null;
        for (Size s : all) {
            if (!is43(s) || s.getWidth() > 1920 || s.getHeight() > 1440 || s.getWidth() < s.getHeight()) continue;
            if (best == null || (long) s.getWidth() * s.getHeight() > (long) best.getWidth() * best.getHeight()) best = s;
        }
        if (best != null) return best;
        for (Size s : all) {
            if (s.getWidth() > 1920 || s.getHeight() > 1080) continue;
            if (best == null || (long) s.getWidth() * s.getHeight() > (long) best.getWidth() * best.getHeight()) best = s;
        }
        return best != null ? best : all[all.length - 1];
    }

    // ------------------------------------------------------------------ the automatic-settings plan
    static final class Plan {
        String cameraId;
        String hwLevel;
        boolean manual;          // true: ISO + shutter set exactly (MANUAL_SENSOR). false: auto exposure, locked before the shot.
        int iso;
        long exposureNs;
        long frameNs;
        int awbMode;             // a fixed preset (daylight ...) or AUTO (then locked before the shot)
        boolean awbLock;
        int afMode;
        boolean afTrigger;
        int antibanding = -1;
        Size jpeg;
        Size preview;
        int sensorOrientation;
        double focal35;
        String isoRange = "";
        String exposureRangeMs = "";
        final List<String> notes = new ArrayList<String>();

        JSONObject toJson() {
            JSONObject o = new JSONObject();
            try {
                o.put("camera_id", cameraId);
                o.put("hw_level", hwLevel);
                o.put("mode", manual ? "manual" : "locked_auto");
                o.put("iso", manual ? iso : JSONObject.NULL);
                o.put("exposure_ms", manual ? exposureNs / 1e6 : JSONObject.NULL);
                o.put("frame_ms", manual ? frameNs / 1e6 : JSONObject.NULL);
                o.put("white_balance", awbName(awbMode) + (awbLock ? " (locked)" : ""));
                o.put("awb_locked", awbLock);
                o.put("af", afTrigger ? "auto-focus" : "fixed");
                o.put("jpeg", jpeg == null ? JSONObject.NULL : jpeg.getWidth() + "x" + jpeg.getHeight());
                o.put("preview", preview == null ? JSONObject.NULL : preview.getWidth() + "x" + preview.getHeight());
                o.put("sensor_orientation", sensorOrientation);
                o.put("focal35", focal35 > 0 ? Math.round(focal35 * 10) / 10.0 : JSONObject.NULL);
                o.put("iso_range", isoRange);
                o.put("exposure_range_ms", exposureRangeMs);
                o.put("notes", new JSONArray(notes));
            } catch (JSONException ignored) {
                // not reachable
            }
            return o;
        }
    }

    static Plan plan(CameraManager m, String id, int isoWanted, long expWantedNs, String awbWanted, int jpegTargetWidth)
            throws CameraAccessException {
        CameraCharacteristics c = m.getCameraCharacteristics(id);
        Plan p = new Plan();
        p.cameraId = id;
        p.hwLevel = hwLevelName(c.get(CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL));
        Integer so = c.get(CameraCharacteristics.SENSOR_ORIENTATION);
        p.sensorOrientation = so == null ? 90 : so;
        p.focal35 = focal35(c);

        StreamConfigurationMap map = c.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
        if (map == null) throw new IllegalStateException("camera " + id + " has no stream configuration map");
        p.jpeg = chooseJpegSize(map, jpegTargetWidth);
        if (p.jpeg == null) throw new IllegalStateException("camera " + id + " offers no JPEG sizes");
        p.preview = choosePreviewSize(map);
        if (!is43(p.jpeg)) p.notes.add("No 4:3 photo size; using " + p.jpeg.getWidth() + "x" + p.jpeg.getHeight());

        // exposure: exact ISO + shutter when the phone allows apps to set them
        Range<Integer> isoR = c.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE);
        Range<Long> expR = c.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE);
        Long maxFrame = c.get(CameraCharacteristics.SENSOR_INFO_MAX_FRAME_DURATION);
        if (isoR != null) p.isoRange = isoR.getLower() + "-" + isoR.getUpper();
        if (expR != null) p.exposureRangeMs = (expR.getLower() / 1e6) + "-" + (expR.getUpper() / 1e6);
        boolean manualSensor = hasCap(c, CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR);
        boolean aeOff = contains(c.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_MODES), CameraMetadata.CONTROL_AE_MODE_OFF);
        p.manual = manualSensor && aeOff && isoR != null && expR != null;
        if (p.manual) {
            p.iso = Math.max(isoR.getLower(), Math.min(isoR.getUpper(), isoWanted));
            if (p.iso != isoWanted) p.notes.add("ISO " + isoWanted + " not supported; using ISO " + p.iso);
            p.exposureNs = Math.max(expR.getLower(), Math.min(expR.getUpper(), expWantedNs));
            if (p.exposureNs != expWantedNs) p.notes.add("Shutter adjusted to " + (p.exposureNs / 1e6) + " ms");
            long fd = Math.max(p.exposureNs, 33333333L);
            fd = Math.max(fd, map.getOutputMinFrameDuration(ImageFormat.JPEG, p.jpeg));
            if (maxFrame != null && maxFrame > 0 && fd > maxFrame) fd = maxFrame;
            p.frameNs = fd;
        } else {
            p.notes.add("This phone doesn't let apps set ISO/shutter (" + p.hwLevel + "); exposure is measured, then locked for the shot");
            int[] ab = c.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_ANTIBANDING_MODES);
            if (contains(ab, CameraMetadata.CONTROL_AE_ANTIBANDING_MODE_50HZ)) p.antibanding = CameraMetadata.CONTROL_AE_ANTIBANDING_MODE_50HZ;
            else if (contains(ab, CameraMetadata.CONTROL_AE_ANTIBANDING_MODE_AUTO)) p.antibanding = CameraMetadata.CONTROL_AE_ANTIBANDING_MODE_AUTO;
        }

        // white balance: a fixed preset, so every photo gets the same colour gains
        int[] awbModes = c.get(CameraCharacteristics.CONTROL_AWB_AVAILABLE_MODES);
        int want = awbFromName(awbWanted);
        if (want >= 0 && contains(awbModes, want)) p.awbMode = want;
        else if (contains(awbModes, CameraMetadata.CONTROL_AWB_MODE_DAYLIGHT)) {
            p.awbMode = CameraMetadata.CONTROL_AWB_MODE_DAYLIGHT;
            if (want >= 0) p.notes.add("White balance '" + awbWanted + "' not available; using daylight");
        } else {
            p.awbMode = CameraMetadata.CONTROL_AWB_MODE_AUTO;
            p.awbLock = true;
            p.notes.add("No fixed white-balance presets; auto white balance is locked before the shot");
        }

        // focus
        Float minFocus = c.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE);
        int[] afModes = c.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES);
        boolean canFocus = minFocus != null && minFocus > 0;
        if (canFocus && contains(afModes, CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE)) {
            p.afMode = CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE;
            p.afTrigger = true;
        } else if (canFocus && contains(afModes, CameraMetadata.CONTROL_AF_MODE_AUTO)) {
            p.afMode = CameraMetadata.CONTROL_AF_MODE_AUTO;
            p.afTrigger = true;
        } else {
            p.afMode = CameraMetadata.CONTROL_AF_MODE_OFF;
            p.afTrigger = false;
        }
        return p;
    }

    // ------------------------------------------------------------------ capabilities report ("Camera check" in the app)
    static JSONObject capabilities(Context ctx) throws JSONException {
        JSONObject out = new JSONObject();
        out.put("device", deviceInfo());
        JSONArray cams = new JSONArray();
        CameraManager m = (CameraManager) ctx.getSystemService(Context.CAMERA_SERVICE);
        if (m == null) {
            out.put("error", "Camera service not available");
            return out;
        }
        try {
            for (String id : m.getCameraIdList()) {
                JSONObject j = new JSONObject();
                j.put("id", id);
                try {
                    CameraCharacteristics c = m.getCameraCharacteristics(id);
                    Integer facing = c.get(CameraCharacteristics.LENS_FACING);
                    j.put("facing", facing == null ? "?" : facing == CameraMetadata.LENS_FACING_BACK ? "back" : facing == CameraMetadata.LENS_FACING_FRONT ? "front" : "external");
                    j.put("hw_level", hwLevelName(c.get(CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL)));
                    j.put("manual_sensor", hasCap(c, CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR));
                    j.put("manual_post", hasCap(c, CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_POST_PROCESSING));
                    Range<Integer> isoR = c.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE);
                    Range<Long> expR = c.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE);
                    if (isoR != null) j.put("iso_range", isoR.getLower() + "-" + isoR.getUpper());
                    if (expR != null) j.put("exposure_range_ms", (expR.getLower() / 1e6) + "-" + (expR.getUpper() / 1e6));
                    double f = focal35(c);
                    if (f > 0) j.put("focal35", Math.round(f * 10) / 10.0);
                    JSONArray awb = new JSONArray();
                    int[] awbModes = c.get(CameraCharacteristics.CONTROL_AWB_AVAILABLE_MODES);
                    if (awbModes != null) for (int a : awbModes) awb.put(awbName(a));
                    j.put("awb_modes", awb);
                    StreamConfigurationMap map = c.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
                    if (map != null) {
                        Size js = chooseJpegSize(map, 4096);
                        if (js != null) j.put("photo_size", js.getWidth() + "x" + js.getHeight());
                    }
                } catch (Throwable t) {
                    j.put("error", t.toString());
                }
                cams.put(j);
            }
            out.put("cameras", cams);
            String chosen = chooseBackCamera(m);
            out.put("chosen", chosen == null ? JSONObject.NULL : chosen);
            if (chosen != null) out.put("plan", plan(m, chosen, 80, 10000000L, "daylight", 4096).toJson());
        } catch (Throwable t) {
            out.put("cameras", cams);
            out.put("error", t.toString());
        }
        return out;
    }
}
