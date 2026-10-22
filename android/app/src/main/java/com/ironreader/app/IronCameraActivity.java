package com.ironreader.app;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.ImageFormat;
import android.graphics.Matrix;
import android.graphics.RectF;
import android.graphics.SurfaceTexture;
import android.graphics.drawable.GradientDrawable;
import android.hardware.display.DisplayManager;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureFailure;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.CaptureResult;
import android.hardware.camera2.TotalCaptureResult;
import android.media.Image;
import android.media.ImageReader;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.OrientationEventListener;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Arrays;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Full-screen in-app camera that applies the validated capture settings itself
 * (ISO 80, 1/100 s, fixed white balance, flash off, main camera at 1x, ~4096x3072 JPEG).
 * Every failure is returned to the app as a coded error with the camera log, never a silent close.
 */
public class IronCameraActivity extends Activity {

    static final String EXTRA_OPTIONS = "options";
    static final String EXTRA_RESULT = "result";
    static final String EXTRA_ERROR = "error";
    static final int RESULT_ERROR = Activity.RESULT_FIRST_USER;

    private static final int ST_IDLE = 0, ST_PREVIEW = 1, ST_FOCUSING = 2, ST_LOCKING = 3, ST_CAPTURING = 4;

    private TextureView textureView;
    private TextView statusView, hintView;
    private Button shutterBtn;

    private HandlerThread bgThread;
    private Handler bg;
    private final Handler ui = new Handler(Looper.getMainLooper());

    private CameraManager manager;
    private CameraCharacteristics chars;
    private CameraDevice camera;
    private CameraCaptureSession session;
    private ImageReader reader;
    private Surface previewSurface;
    private CaptureRequest.Builder previewBuilder;
    private IronCameraSupport.Plan plan;

    private volatile int state = ST_IDLE;
    private volatile boolean finished = false;
    private volatile boolean paused = true;
    private volatile boolean resumedOnce = false;
    private volatile boolean opening = false;   // an open request is in flight: don't start a second one
    private boolean aeLocked = false, awbLocked = false;
    private int frameCount = 0, lockFrames = 0;
    private volatile int lastDeviceOrientation = OrientationEventListener.ORIENTATION_UNKNOWN;
    private OrientationEventListener orientationListener;
    private final DisplayManager.DisplayListener displayListener = new DisplayManager.DisplayListener() {
        @Override
        public void onDisplayAdded(int id) {
            // not used
        }

        @Override
        public void onDisplayRemoved(int id) {
            // not used
        }

        @Override
        public void onDisplayChanged(int id) {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    configureTransform();
                }
            });
        }
    };
    private int jpegOrientation = 0;
    private TotalCaptureResult stillResult;
    private byte[] jpegBytes;
    private int jpegW, jpegH;
    private String step = "start";
    private Runnable pendingTimeout;
    private final ArrayList<String> warnings = new ArrayList<String>();
    private JSONObject options = new JSONObject();

    // ================================================================== lifecycle
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        try {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON | WindowManager.LayoutParams.FLAG_FULLSCREEN);
            String o = getIntent().getStringExtra(EXTRA_OPTIONS);
            if (o != null && o.length() > 0) options = new JSONObject(o);
            buildUi();
            orientationListener = new OrientationEventListener(this) {
                @Override
                public void onOrientationChanged(int orientation) {
                    if (orientation != ORIENTATION_UNKNOWN) lastDeviceOrientation = orientation;
                }
            };
            if (orientationListener.canDetectOrientation()) orientationListener.enable();
            IronCameraSupport.log("camera screen created");
        } catch (Throwable t) {
            fail("E-CAM-UI", "Could not build the camera screen", t);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        paused = false;
        resumedOnce = true;
        try {
            DisplayManager dm = (DisplayManager) getSystemService(Context.DISPLAY_SERVICE);
            if (dm != null) dm.registerDisplayListener(displayListener, ui);
        } catch (Throwable ignored) {
            // preview may stay rotated after a flip; photo orientation is unaffected
        }
        startBg();
        if (!finished && textureView != null && textureView.isAvailable()) openCamera();
    }

    @Override
    protected void onPause() {
        paused = true;
        try {
            DisplayManager dm = (DisplayManager) getSystemService(Context.DISPLAY_SERVICE);
            if (dm != null) dm.unregisterDisplayListener(displayListener);
        } catch (Throwable ignored) {
            // nothing registered
        }
        cancelTimeout();
        closeCamera();
        opening = false;   // its callbacks would arrive on the background thread, which stops now; reopen on resume
        state = ST_IDLE;
        aeLocked = false;
        awbLocked = false;
        stopBg();
        if (!finished) IronCameraSupport.log("camera screen paused");
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (orientationListener != null) orientationListener.disable();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        cancel();
    }

    private void startBg() {
        if (bgThread != null) return;
        bgThread = new HandlerThread("IronCameraBg");
        bgThread.start();
        bg = new Handler(bgThread.getLooper());
    }

    private void stopBg() {
        if (bgThread == null) return;
        bgThread.quitSafely();
        bgThread = null;
        bg = null;
    }

    // ================================================================== UI (built in code: no layout resources to break)
    private int dp(float v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    private void buildUi() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        textureView = new TextureView(this);
        root.addView(textureView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        textureView.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
            @Override
            public void onSurfaceTextureAvailable(SurfaceTexture s, int w, int h) {
                if (!paused) openCamera();
            }

            @Override
            public void onSurfaceTextureSizeChanged(SurfaceTexture s, int w, int h) {
                configureTransform();
            }

            @Override
            public boolean onSurfaceTextureDestroyed(SurfaceTexture s) {
                return true;
            }

            @Override
            public void onSurfaceTextureUpdated(SurfaceTexture s) {
                // no-op
            }
        });
        textureView.addOnLayoutChangeListener(new View.OnLayoutChangeListener() {
            @Override
            public void onLayoutChange(View v, int l, int t, int r, int b, int ol, int ot, int or, int ob) {
                configureTransform();
            }
        });

        statusView = new TextView(this);
        statusView.setTextColor(Color.WHITE);
        statusView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        statusView.setBackgroundColor(0x99000000);
        statusView.setPadding(dp(8), dp(6), dp(8), dp(6));
        statusView.setText("Opening camera…");
        FrameLayout.LayoutParams sp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.START);
        sp.setMargins(dp(10), dp(10), dp(120), 0);
        root.addView(statusView, sp);

        hintView = new TextView(this);
        hintView.setTextColor(Color.WHITE);
        hintView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        hintView.setBackgroundColor(0x99000000);
        hintView.setPadding(dp(10), dp(6), dp(10), dp(6));
        hintView.setText("Preparing…");
        FrameLayout.LayoutParams hp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM | Gravity.START);
        hp.setMargins(dp(10), 0, dp(120), dp(10));
        root.addView(hintView, hp);

        LinearLayout side = new LinearLayout(this);
        side.setOrientation(LinearLayout.VERTICAL);
        side.setGravity(Gravity.CENTER);
        FrameLayout.LayoutParams sideLp = new FrameLayout.LayoutParams(dp(110), ViewGroup.LayoutParams.MATCH_PARENT, Gravity.END);
        root.addView(side, sideLp);

        shutterBtn = new Button(this);
        shutterBtn.setText("CAPTURE");
        shutterBtn.setTextColor(Color.BLACK);
        shutterBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        GradientDrawable round = new GradientDrawable();
        round.setShape(GradientDrawable.OVAL);
        round.setColor(Color.WHITE);
        round.setStroke(dp(4), 0xFF5B7CFA);
        shutterBtn.setBackground(round);
        shutterBtn.setEnabled(false);
        shutterBtn.setAlpha(0.4f);
        shutterBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                onShutter();
            }
        });
        side.addView(shutterBtn, new LinearLayout.LayoutParams(dp(84), dp(84)));

        Button cancelBtn = new Button(this);
        cancelBtn.setText("Cancel");
        cancelBtn.setTextColor(Color.WHITE);
        cancelBtn.setBackgroundColor(0x00000000);
        cancelBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                cancel();
            }
        });
        LinearLayout.LayoutParams cl = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        cl.topMargin = dp(24);
        side.addView(cancelBtn, cl);

        setContentView(root);
    }

    private void setHint(final String text) {
        ui.post(new Runnable() {
            @Override
            public void run() {
                if (hintView != null) hintView.setText(text);
            }
        });
    }

    private void setShutterEnabled(final boolean on) {
        ui.post(new Runnable() {
            @Override
            public void run() {
                if (shutterBtn == null) return;
                shutterBtn.setEnabled(on);
                shutterBtn.setAlpha(on ? 1f : 0.4f);
            }
        });
    }

    private void showPlan() {
        final IronCameraSupport.Plan p = plan;
        if (p == null) return;
        StringBuilder sb = new StringBuilder();
        if (p.manual) {
            sb.append("Automatic settings: ISO ").append(p.iso)
              .append(" · 1/").append(Math.round(1e9 / p.exposureNs)).append(" s");
        } else {
            sb.append("Automatic settings: exposure measured, then locked");
        }
        sb.append(" · WB ").append(IronCameraSupport.awbName(p.awbMode)).append(p.awbLock ? " (locked)" : "")
          .append(" · flash off · 1x\n")
          .append("Camera ").append(p.cameraId).append(" (").append(p.hwLevel).append(") · photo ")
          .append(p.jpeg.getWidth()).append("×").append(p.jpeg.getHeight());
        for (String n : p.notes) sb.append("\n• ").append(n);
        final String text = sb.toString();
        ui.post(new Runnable() {
            @Override
            public void run() {
                if (statusView != null) statusView.setText(text);
            }
        });
    }

    /**
     * Fit the whole 4:3 frame on screen (letterboxed) in the area left of the Capture/Cancel column, so the user sees
     * exactly what the photo will contain and no button covers it. Works for phones (natural portrait) and for tablets
     * whose natural orientation is landscape, in either landscape direction.
     */
    private void configureTransform() {
        final IronCameraSupport.Plan p = plan;
        if (p == null || textureView == null || p.preview == null) return;
        float vw = textureView.getWidth(), vh = textureView.getHeight();
        if (vw == 0 || vh == 0) return;
        int rotation = getWindowManager().getDefaultDisplay().getRotation();
        int deg = rotation == Surface.ROTATION_90 ? 90 : rotation == Surface.ROTATION_180 ? 180 : rotation == Surface.ROTATION_270 ? 270 : 0;
        float pw = p.preview.getWidth(), ph = p.preview.getHeight();
        // TextureView already turns the camera image upright for the phone's NATURAL orientation and stretches it to the view
        boolean sensorQuarter = (p.sensorOrientation % 180) != 0;
        float natW = sensorQuarter ? ph : pw, natH = sensorQuarter ? pw : ph;
        boolean screenQuarter = (deg % 180) != 0;
        float shownW = screenQuarter ? natH : natW, shownH = screenQuarter ? natW : natH;   // as it appears on this screen
        float panel = Math.min(dp(110), vw * 0.25f);
        float availW = Math.max(vw - panel, vw * 0.5f);
        float s = Math.min(availW / shownW, vh / shownH);
        float cx = vw / 2f, cy = vh / 2f;
        Matrix m = new Matrix();
        RectF nat = new RectF(0, 0, natW, natH);
        nat.offset(cx - nat.centerX(), cy - nat.centerY());
        m.setRectToRect(new RectF(0, 0, vw, vh), nat, Matrix.ScaleToFit.FILL);   // undo the stretch
        m.postScale(s, s, cx, cy);                                               // fit
        if (deg != 0) m.postRotate(-deg, cx, cy);                                // undo the screen rotation
        m.postTranslate((availW - vw) / 2f, 0);                                  // centre in the area left of the buttons
        textureView.setTransform(m);
    }

    // ================================================================== timeouts
    private void armTimeout(long ms, final String code, final String message) {
        armSoft(ms, new Runnable() {
            @Override
            public void run() {
                fail(code, message, null);
            }
        });
    }

    private void armSoft(long ms, Runnable r) {
        cancelTimeout();
        Handler h = bg;
        if (h == null) return;
        pendingTimeout = r;
        h.postDelayed(r, ms);
    }

    private void cancelTimeout() {
        Handler h = bg;
        if (h != null && pendingTimeout != null) h.removeCallbacks(pendingTimeout);
        pendingTimeout = null;
    }

    private void setStep(String s) {
        step = s;
        IronCameraSupport.log("step: " + s);
    }

    private void warn(String w) {
        warnings.add(w);
        IronCameraSupport.log("warning: " + w);
    }

    // ================================================================== camera open / session / preview
    private void openCamera() {
        if (finished || camera != null || opening || bg == null) return;
        opening = true;
        setStep("open");
        bg.post(new Runnable() {
            @Override
            public void run() {
                try {
                    if (Build.VERSION.SDK_INT >= 23 && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                        fail("E-CAM-PERM", "Camera permission is not granted. Allow it in Android Settings → Apps → Iron Reader → Permissions.", null);
                        return;
                    }
                    manager = (CameraManager) getSystemService(Context.CAMERA_SERVICE);
                    if (manager == null) {
                        fail("E-CAM-SERVICE", "This phone's camera service is not available", null);
                        return;
                    }
                    String wanted = options.optString("cameraId", "");
                    final String id = wanted.length() > 0 ? wanted : IronCameraSupport.chooseBackCamera(manager);
                    if (id == null) {
                        fail("E-CAM-NONE", "No usable back camera was found on this phone", null);
                        return;
                    }
                    chars = manager.getCameraCharacteristics(id);
                    plan = IronCameraSupport.plan(manager, id, options.optInt("iso", 80), options.optLong("exposureNs", 10000000L),
                            options.optString("whiteBalance", "daylight"), options.optInt("jpegWidth", 4096));
                    IronCameraSupport.log("plan " + plan.toJson().toString());
                    showPlan();
                    ui.post(new Runnable() {
                        @Override
                        public void run() {
                            configureTransform();
                        }
                    });
                    armTimeout(10000, "E-CAM-OPEN-TIMEOUT", "The camera did not open within 10 s (is another app using it?)");
                    manager.openCamera(id, deviceCallback, bg);
                } catch (CameraAccessException e) {
                    fail("E-CAM-ACCESS-" + e.getReason(), "The phone refused access to the camera", e);
                } catch (Throwable t) {
                    fail("E-CAM-OPEN", "Could not open the camera", t);
                }
            }
        });
    }

    private final CameraDevice.StateCallback deviceCallback = new CameraDevice.StateCallback() {
        @Override
        public void onOpened(CameraDevice cd) {
            opening = false;
            cancelTimeout();
            if (finished || paused) {
                cd.close();
                return;
            }
            camera = cd;
            IronCameraSupport.log("camera opened");
            createSession();
        }

        @Override
        public void onDisconnected(CameraDevice cd) {
            opening = false;
            cd.close();
            camera = null;
            if (!paused) fail("E-CAM-DISCONNECTED", "The camera was disconnected (another app may have taken it)", null);
        }

        @Override
        public void onError(CameraDevice cd, int error) {
            opening = false;
            cd.close();
            camera = null;
            String[] names = { "", "camera in use", "too many cameras open", "camera disabled by policy", "camera device error", "camera service error" };
            String n = error > 0 && error < names.length ? names[error] : "unknown";
            fail("E-CAM-DEVICE-" + error, "Camera error: " + n, null);
        }
    };

    private void createSession() {
        setStep("session");
        try {
            SurfaceTexture st = textureView.getSurfaceTexture();
            if (st == null) {
                fail("E-CAM-PREVIEW", "The preview surface was not ready", null);
                return;
            }
            st.setDefaultBufferSize(plan.preview.getWidth(), plan.preview.getHeight());
            previewSurface = new Surface(st);
            reader = ImageReader.newInstance(plan.jpeg.getWidth(), plan.jpeg.getHeight(), ImageFormat.JPEG, 2);
            reader.setOnImageAvailableListener(new ImageReader.OnImageAvailableListener() {
                @Override
                public void onImageAvailable(ImageReader r) {
                    onJpeg(r);
                }
            }, bg);
            armTimeout(10000, "E-CAM-SESSION-TIMEOUT", "The camera session was not ready within 10 s");
            camera.createCaptureSession(Arrays.asList(previewSurface, reader.getSurface()), sessionCallback, bg);
        } catch (Throwable t) {
            fail("E-CAM-SESSION", "Could not configure the camera", t);
        }
    }

    private final CameraCaptureSession.StateCallback sessionCallback = new CameraCaptureSession.StateCallback() {
        @Override
        public void onConfigured(CameraCaptureSession s) {
            cancelTimeout();
            if (finished || paused || camera == null) return;
            session = s;
            startPreview();
        }

        @Override
        public void onConfigureFailed(CameraCaptureSession s) {
            fail("E-CAM-CONFIG", "The camera refused the configuration (preview " + plan.preview.getWidth() + "x" + plan.preview.getHeight()
                    + " + photo " + plan.jpeg.getWidth() + "x" + plan.jpeg.getHeight() + ")", null);
        }
    };

    private void applyPlan(CaptureRequest.Builder b) {
        b.set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO);
        b.set(CaptureRequest.FLASH_MODE, CaptureRequest.FLASH_MODE_OFF);
        b.set(CaptureRequest.CONTROL_EFFECT_MODE, CaptureRequest.CONTROL_EFFECT_MODE_OFF);
        if (plan.manual) {
            b.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_OFF);
            b.set(CaptureRequest.SENSOR_SENSITIVITY, plan.iso);
            b.set(CaptureRequest.SENSOR_EXPOSURE_TIME, plan.exposureNs);
            b.set(CaptureRequest.SENSOR_FRAME_DURATION, plan.frameNs);
        } else {
            b.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON);
            b.set(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, 0);
            if (plan.antibanding >= 0) b.set(CaptureRequest.CONTROL_AE_ANTIBANDING_MODE, plan.antibanding);
            b.set(CaptureRequest.CONTROL_AE_LOCK, aeLocked);
        }
        b.set(CaptureRequest.CONTROL_AWB_MODE, plan.awbMode);
        if (plan.awbLock) b.set(CaptureRequest.CONTROL_AWB_LOCK, awbLocked);
        b.set(CaptureRequest.CONTROL_AF_MODE, plan.afMode);
    }

    private void startPreview() {
        setStep("preview");
        try {
            previewBuilder = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
            previewBuilder.addTarget(previewSurface);
            applyPlan(previewBuilder);
            session.setRepeatingRequest(previewBuilder.build(), previewCallback, bg);
            state = ST_PREVIEW;
            frameCount = 0;
            IronCameraSupport.log("preview running");
            setHint("Fit the tube and the whole 9-patch card in the frame, then tap CAPTURE.");
            setShutterEnabled(true);
        } catch (Throwable t) {
            fail("E-CAM-PREVIEW", "Could not start the camera preview", t);
        }
    }

    private final CameraCaptureSession.CaptureCallback previewCallback = new CameraCaptureSession.CaptureCallback() {
        @Override
        public void onCaptureCompleted(CameraCaptureSession s, CaptureRequest r, TotalCaptureResult res) {
            try {
                frameCount++;
                if (frameCount == 1) IronCameraSupport.log("first preview frame " + actualSettings(res).toString());
                progress(res);
            } catch (Throwable t) {
                fail("E-CAM-STATE", "Camera state error during preview", t);
            }
        }
    };

    private void progress(TotalCaptureResult res) {
        if (state == ST_FOCUSING) {
            Integer af = res.get(CaptureResult.CONTROL_AF_STATE);
            if (af == null || af == CaptureResult.CONTROL_AF_STATE_FOCUSED_LOCKED || af == CaptureResult.CONTROL_AF_STATE_NOT_FOCUSED_LOCKED) {
                if (af != null && af == CaptureResult.CONTROL_AF_STATE_NOT_FOCUSED_LOCKED) warn("Autofocus could not confirm sharp focus");
                afterFocus();
            }
        } else if (state == ST_LOCKING) {
            lockFrames++;
            Integer ae = res.get(CaptureResult.CONTROL_AE_STATE);
            boolean aeOk = plan.manual || ae == null || ae == CaptureResult.CONTROL_AE_STATE_LOCKED;
            if (aeOk && lockFrames >= 3) captureStill();
        }
    }

    // ================================================================== taking the photo
    private void onShutter() {
        if (state != ST_PREVIEW || finished || bg == null) return;
        setShutterEnabled(false);
        bg.post(new Runnable() {
            @Override
            public void run() {
                startCaptureSequence();
            }
        });
    }

    private void cancel() {
        if (finished) return;
        finished = true;
        IronCameraSupport.log("cancelled by user");
        setResult(Activity.RESULT_CANCELED);
        closeCamera();
        finish();
    }

    private void startCaptureSequence() {
        if (state != ST_PREVIEW || finished) return;
        try {
            jpegBytes = null;
            stillResult = null;
            jpegOrientation = computeJpegOrientation();
            if (plan.afTrigger) {
                setStep("focus");
                state = ST_FOCUSING;
                setHint("Focusing…");
                previewBuilder.set(CaptureRequest.CONTROL_AF_TRIGGER, CaptureRequest.CONTROL_AF_TRIGGER_START);
                session.capture(previewBuilder.build(), previewCallback, bg);
                previewBuilder.set(CaptureRequest.CONTROL_AF_TRIGGER, CaptureRequest.CONTROL_AF_TRIGGER_IDLE);
                armSoft(3000, new Runnable() {
                    @Override
                    public void run() {
                        if (state == ST_FOCUSING) {
                            warn("Autofocus did not settle within 3 s; photo taken anyway");
                            afterFocus();
                        }
                    }
                });
            } else {
                afterFocus();
            }
        } catch (Throwable t) {
            fail("E-CAM-FOCUS", "Could not start focusing", t);
        }
    }

    private void afterFocus() {
        if (state == ST_LOCKING || state == ST_CAPTURING || finished) return;
        cancelTimeout();
        try {
            if (!plan.manual || plan.awbLock) {
                setStep("lock");
                state = ST_LOCKING;
                lockFrames = 0;
                setHint("Locking exposure…");
                if (!plan.manual) aeLocked = true;
                if (plan.awbLock) awbLocked = true;
                applyPlan(previewBuilder);
                session.setRepeatingRequest(previewBuilder.build(), previewCallback, bg);
                armSoft(2500, new Runnable() {
                    @Override
                    public void run() {
                        if (state == ST_LOCKING) {
                            warn("Exposure lock not confirmed within 2.5 s; photo taken anyway");
                            captureStill();
                        }
                    }
                });
            } else {
                captureStill();
            }
        } catch (Throwable t) {
            fail("E-CAM-LOCK", "Could not lock exposure / white balance", t);
        }
    }

    private void captureStill() {
        if (state == ST_CAPTURING || finished) return;
        cancelTimeout();
        state = ST_CAPTURING;
        setStep("capture");
        setHint("Capturing… hold still");
        try {
            CaptureRequest.Builder b = camera.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE);
            b.addTarget(reader.getSurface());
            applyPlan(b);
            b.set(CaptureRequest.JPEG_ORIENTATION, jpegOrientation);
            b.set(CaptureRequest.JPEG_QUALITY, (byte) 95);
            armTimeout(8000, "E-CAM-CAPTURE-TIMEOUT", "The photo was not delivered by the camera within 8 s");
            session.capture(b.build(), stillCallback, bg);
        } catch (Throwable t) {
            fail("E-CAM-CAPTURE", "Could not take the photo", t);
        }
    }

    private final CameraCaptureSession.CaptureCallback stillCallback = new CameraCaptureSession.CaptureCallback() {
        @Override
        public void onCaptureCompleted(CameraCaptureSession s, CaptureRequest r, TotalCaptureResult res) {
            stillResult = res;
            IronCameraSupport.log("still capture completed");
            maybeFinish();
        }

        @Override
        public void onCaptureFailed(CameraCaptureSession s, CaptureRequest r, CaptureFailure f) {
            fail("E-CAM-CAPTURE-FAILED", "The camera reported a failed capture (reason " + f.getReason() + ")", null);
        }
    };

    private void onJpeg(ImageReader r) {
        Image img = null;
        try {
            img = r.acquireNextImage();
            if (img == null) return;
            ByteBuffer buf = img.getPlanes()[0].getBuffer();
            byte[] b = new byte[buf.remaining()];
            buf.get(b);
            jpegBytes = b;
            jpegW = img.getWidth();
            jpegH = img.getHeight();
            IronCameraSupport.log("jpeg received " + b.length + " bytes");
            maybeFinish();
        } catch (Throwable t) {
            fail("E-CAM-IMAGE", "Could not read the photo data from the camera", t);
        } finally {
            if (img != null) img.close();
        }
    }

    private void maybeFinish() {
        if (finished || jpegBytes == null || stillResult == null) return;
        cancelTimeout();
        setStep("save");
        try {
            File dir = new File(getCacheDir(), "iron_capture");
            if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("cannot create " + dir);
            File[] old = dir.listFiles();
            if (old != null) for (File f : old) f.delete();
            File f = new File(dir, "IMG_" + System.currentTimeMillis() + ".jpg");
            FileOutputStream fos = new FileOutputStream(f);
            fos.write(jpegBytes);
            fos.close();

            JSONObject out = new JSONObject();
            out.put("path", f.getAbsolutePath());
            out.put("width", jpegW);
            out.put("height", jpegH);
            out.put("bytes", jpegBytes.length);
            out.put("jpeg_orientation", jpegOrientation);
            out.put("device_orientation", lastDeviceOrientation);
            out.put("plan", plan.toJson());
            out.put("actual", actualSettings(stillResult));
            out.put("warnings", new JSONArray(warnings));
            out.put("device", IronCameraSupport.deviceInfo());
            IronCameraSupport.log("saved " + f.getName());
            out.put("log", IronCameraSupport.logTail(25));
            finished = true;
            final Intent data = new Intent();
            data.putExtra(EXTRA_RESULT, out.toString());
            ui.post(new Runnable() {
                @Override
                public void run() {
                    setResult(Activity.RESULT_OK, data);
                    closeCamera();
                    finish();
                }
            });
        } catch (Throwable t) {
            fail("E-CAM-SAVE", "Could not save the photo on the phone", t);
        }
    }

    // ================================================================== helpers
    private JSONObject actualSettings(TotalCaptureResult r) {
        JSONObject a = new JSONObject();
        try {
            Integer iso = r.get(CaptureResult.SENSOR_SENSITIVITY);
            Long exp = r.get(CaptureResult.SENSOR_EXPOSURE_TIME);
            Long fd = r.get(CaptureResult.SENSOR_FRAME_DURATION);
            if (iso != null) a.put("iso", iso.intValue());
            if (exp != null) a.put("exposure_time_s", exp / 1e9);
            if (fd != null) a.put("frame_duration_s", fd / 1e9);
            putInt(a, "ae_mode", r.get(CaptureResult.CONTROL_AE_MODE));
            putInt(a, "ae_state", r.get(CaptureResult.CONTROL_AE_STATE));
            putInt(a, "awb_mode", r.get(CaptureResult.CONTROL_AWB_MODE));
            putInt(a, "awb_state", r.get(CaptureResult.CONTROL_AWB_STATE));
            putInt(a, "af_mode", r.get(CaptureResult.CONTROL_AF_MODE));
            putInt(a, "af_state", r.get(CaptureResult.CONTROL_AF_STATE));
            putInt(a, "flash_mode", r.get(CaptureResult.FLASH_MODE));
            putInt(a, "flash_state", r.get(CaptureResult.FLASH_STATE));
            Float fl = r.get(CaptureResult.LENS_FOCAL_LENGTH);
            if (fl != null) a.put("focal_length_mm", fl.doubleValue());
            Float fdist = r.get(CaptureResult.LENS_FOCUS_DISTANCE);
            if (fdist != null) a.put("focus_distance_diopters", fdist.doubleValue());
            if (Build.VERSION.SDK_INT >= 30) {
                Float z = r.get(CaptureResult.CONTROL_ZOOM_RATIO);
                if (z != null) a.put("zoom_ratio", z.doubleValue());
            }
        } catch (Throwable t) {
            IronCameraSupport.log("actualSettings: " + t);
        }
        return a;
    }

    private static void putInt(JSONObject o, String k, Integer v) throws org.json.JSONException {
        if (v != null) o.put(k, v.intValue());
    }

    /** Same rule as the phone's own camera: the photo is upright for the way the phone is held (gravity). */
    private int computeJpegOrientation() {
        Integer so = chars.get(CameraCharacteristics.SENSOR_ORIENTATION);
        int sensor = so == null ? 90 : so;
        // The photo matches the PREVIEW (screen orientation), not gravity: in a lightbox the phone points down or
        // sits at an angle, where gravity is meaningless (v3 got "portrait" photos that way). The screen is always
        // landscape here, so the photo is always landscape and upright exactly as the user framed it.
        int rot = getWindowManager().getDefaultDisplay().getRotation();
        int deg = rot == Surface.ROTATION_90 ? 90 : rot == Surface.ROTATION_180 ? 180 : rot == Surface.ROTATION_270 ? 270 : 0;
        int o = (sensor - deg + 360) % 360;
        IronCameraSupport.log("jpeg orientation " + o + " (sensor " + sensor + ", screen " + deg + ", gravity " + lastDeviceOrientation + ")");
        return o;
    }

    private void closeCamera() {
        try {
            if (session != null) session.close();
        } catch (Throwable ignored) {
            // closing
        }
        session = null;
        try {
            if (camera != null) camera.close();
        } catch (Throwable ignored) {
            // closing
        }
        camera = null;
        try {
            if (reader != null) reader.close();
        } catch (Throwable ignored) {
            // closing
        }
        reader = null;
    }

    /** Return a coded error (with the camera log and plan) to the app, which shows it on screen. */
    private void fail(String code, String message, Throwable t) {
        opening = false;
        if (finished) return;
        if (paused && resumedOnce && !code.startsWith("E-CAM-PERM")) {
            // the camera is closed on purpose when the app goes to the background; it is reopened on return
            IronCameraSupport.log("ignored while paused: " + code + " " + message + (t != null ? " / " + t : ""));
            return;
        }
        finished = true;
        cancelTimeout();
        IronCameraSupport.log("FAIL " + code + ": " + message + (t != null ? " / " + t : ""));
        JSONObject e = new JSONObject();
        try {
            e.put("code", code);
            e.put("message", message);
            e.put("step", step);
            if (t != null) {
                e.put("exception", t.toString());
                e.put("stack", IronCameraSupport.stackOf(t, 8));
            }
            e.put("device", IronCameraSupport.deviceInfo());
            if (plan != null) e.put("plan", plan.toJson());
            e.put("warnings", new JSONArray(warnings));
            e.put("log", IronCameraSupport.logTail(25));
        } catch (Throwable ignored) {
            // best effort
        }
        final Intent data = new Intent();
        data.putExtra(EXTRA_ERROR, e.toString());
        ui.post(new Runnable() {
            @Override
            public void run() {
                setResult(RESULT_ERROR, data);
                closeCamera();
                finish();
            }
        });
    }
}
