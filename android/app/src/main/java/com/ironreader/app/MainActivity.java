package com.ironreader.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // the app's own camera (in-app capture with the validated settings) -- must be registered before super.onCreate
        registerPlugin(IronCameraPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
