package com.ironreader.app;

import android.os.Bundle;
import android.webkit.ValueCallback;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // the app's own camera (in-app capture with the validated settings) -- must be registered before super.onCreate
        registerPlugin(IronCameraPlugin.class);
        super.onCreate(savedInstanceState);

        // Android back button: first let the page close an open sheet / go back from the result screen
        // (window.__ironBack returns true when it handled it). Otherwise send the app to the background
        // instead of closing it, so the current photo / result is still there when the user comes back.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView wv = getBridge() != null ? getBridge().getWebView() : null;
                if (wv == null) {
                    moveTaskToBack(true);
                    return;
                }
                try {
                    wv.evaluateJavascript("(function(){try{return !!(window.__ironBack&&window.__ironBack());}catch(e){return false;}})()",
                            new ValueCallback<String>() {
                                @Override
                                public void onReceiveValue(String handled) {
                                    if (!"true".equals(handled)) moveTaskToBack(true);
                                }
                            });
                } catch (Throwable t) {
                    moveTaskToBack(true);
                }
            }
        });
    }
}
