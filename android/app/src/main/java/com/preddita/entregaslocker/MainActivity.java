package com.preddita.entregaslocker;

import android.annotation.SuppressLint;
import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.lang.reflect.Method;
import java.util.Map;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * PREDDITA Smart Locker - MainActivity
 *
 * Responsibilities:
 *  1. Render the React app inside a fullscreen WebView
 *  2. Expose an Android -> JavaScript bridge for RS-485 commands
 *  3. Probe common serial ports used by the KS1062 and keep the active one open
 */
public class MainActivity extends Activity {

    private static final String TAG = "PredditaLocker";
    private static final String KIOSK_ORIGIN = "https://appassets.androidplatform.net";
    private static final String KIOSK_ASSET_PATH = "/assets/www/";
    private static final String KIOSK_URL = KIOSK_ORIGIN + KIOSK_ASSET_PATH + "index.html";
    private static final int CAMERA_PERMISSION_REQUEST = 4201;
    private static final int BAUD_RATE = 9600;
    private static final String[] SERIAL_PORT_CANDIDATES = new String[]{
        "/dev/ttyS5",
        "/dev/ttyS1",
        "/dev/ttyS2",
        "/dev/ttyS4",
        "/dev/ttyS6",
        "/dev/ttyS7",
        "/dev/ttyS8",
        "/dev/ttyS3",
        "/dev/ttyS0"
    };

    private WebView webView;
    private FileOutputStream serialOut;
    private FileInputStream serialIn;
    private Thread serialThread;
    private final Rs485FrameParser serialFrameParser = new Rs485FrameParser();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private volatile boolean serialOpen = false;
    private volatile String activeSerialPort = SERIAL_PORT_CANDIDATES[0];
    private volatile String lastSerialError = "INIT_PENDING";
    private volatile Object zysjManager;
    private volatile String lastZysjError = "ZYSJ_PENDING";
    private final Map<String, Method> zysjMethodCache = new ConcurrentHashMap<>();
    private final Set<String> zysjMissingMethods = ConcurrentHashMap.newKeySet();

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getWindow().addFlags(
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON |
            WindowManager.LayoutParams.FLAG_FULLSCREEN
        );
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION |
            View.SYSTEM_UI_FLAG_FULLSCREEN |
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        );

        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(
            isDebuggableBuild()
                ? WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
                : WebSettings.MIXED_CONTENT_NEVER_ALLOW
        );
        settings.setMediaPlaybackRequiresUserGesture(false);

        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
            .build();

        webView.addJavascriptInterface(new RS485Bridge(), "Android");
        WebView.setWebContentsDebuggingEnabled(isDebuggableBuild());

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                mainHandler.post(() -> {
                    if (hasCameraPermission() && requestsVideoCapture(request)) {
                        request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                    } else {
                        ensureCameraPermission();
                        request.deny();
                    }
                });
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return !isAllowedKioskUrl(req.getUrl().toString());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return !isAllowedKioskUrl(url);
            }
        });

        ensureCameraPermission();
        webView.loadUrl(KIOSK_URL);
        initSerial();
    }

    private boolean isAllowedKioskUrl(String url) {
        if (url == null) return false;
        Uri uri = Uri.parse(url);
        return "https".equalsIgnoreCase(uri.getScheme())
            && "appassets.androidplatform.net".equalsIgnoreCase(uri.getHost())
            && uri.getPath() != null
            && uri.getPath().startsWith(KIOSK_ASSET_PATH);
    }

    private boolean isDebuggableBuild() {
        return (getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    private boolean hasCameraPermission() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.M ||
            checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
    }

    private void ensureCameraPermission() {
        if (!hasCameraPermission() && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_PERMISSION_REQUEST);
        }
    }

    private boolean requestsVideoCapture(PermissionRequest request) {
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                return true;
            }
        }
        return false;
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        stopSerialThread();
        closeSerialStreams();
    }

    private synchronized void initSerial() {
        stopSerialThread();
        closeSerialStreams();
        serialThread = new Thread(this::openAndReadSerial, "preddita-serial");
        serialThread.start();
    }

    private void openAndReadSerial() {
        try {
            String openedPort = openFirstAvailablePort();
            if (openedPort == null) {
                throw new IOException(lastSerialError);
            }

            serialOpen = true;
            serialFrameParser.reset();
            activeSerialPort = openedPort;
            lastSerialError = "OK";
            Log.i(TAG, "Serial port opened on " + openedPort + " at " + BAUD_RATE + " bps");

            byte[] buffer = new byte[32];
            while (!Thread.currentThread().isInterrupted()) {
                int size = serialIn.read(buffer);
                if (size > 0) {
                    List<byte[]> frames = serialFrameParser.append(buffer, size);
                    for (byte[] frame : frames) {
                        final String hex = formatHexFrame(frame);
                        Log.d(TAG, "RX <- " + hex);
                        mainHandler.post(() -> webView.evaluateJavascript(
                            "window.onRS485Response && window.onRS485Response('" + escapeJs(hex) + "')",
                            null
                        ));
                    }
                }
            }
        } catch (Exception error) {
            serialOpen = false;
            lastSerialError = error.getMessage() != null ? error.getMessage() : "SERIAL_OPEN_FAILED";
            Log.e(TAG, "Serial error: " + lastSerialError, error);
            notifyError("SERIAL_OPEN_FAILED: " + lastSerialError);
        }
    }

    private String openFirstAvailablePort() {
        StringBuilder attempts = new StringBuilder();

        for (String candidate : SERIAL_PORT_CANDIDATES) {
            try {
                preparePort(candidate);
                serialOut = new FileOutputStream(candidate);
                serialIn = new FileInputStream(candidate);
                return candidate;
            } catch (Exception error) {
                closeSerialStreams();
                if (attempts.length() > 0) {
                    attempts.append(" | ");
                }
                attempts.append(candidate).append(": ").append(error.getMessage());
                Log.w(TAG, "Failed to open " + candidate + ": " + error.getMessage());
            }
        }

        lastSerialError = attempts.length() > 0 ? attempts.toString() : "NO_SERIAL_PORT_AVAILABLE";
        return null;
    }

    private void preparePort(String port) {
        runCommand("su", "root", "sh", "-c", "chmod 666 " + port + " && stty -F " + port + " " + BAUD_RATE + " cs8 -cstopb -parenb raw -echo");
        runCommand("sh", "-c", "stty -F " + port + " " + BAUD_RATE + " cs8 -cstopb -parenb raw -echo");
    }

    private void runCommand(String... command) {
        try {
            Process process = Runtime.getRuntime().exec(command);
            process.waitFor();
        } catch (Exception ignored) {
        }
    }

    private synchronized void stopSerialThread() {
        if (serialThread != null) {
            serialThread.interrupt();
            serialThread = null;
        }
    }

    private synchronized void closeSerialStreams() {
        try {
            if (serialOut != null) {
                serialOut.close();
            }
        } catch (IOException ignored) {
        }

        try {
            if (serialIn != null) {
                serialIn.close();
            }
        } catch (IOException ignored) {
        }

        serialOut = null;
        serialIn = null;
        serialOpen = false;
    }

    private String escapeJs(String value) {
        return value
            .replace("\\", "\\\\")
            .replace("'", "\\'")
            .replace("\n", " ")
            .replace("\r", " ");
    }

    private String formatHexFrame(byte[] frame) {
        StringBuilder builder = new StringBuilder();
        for (byte value : frame) {
            if (builder.length() > 0) builder.append(' ');
            builder.append(String.format("%02X", value & 0xFF));
        }
        return builder.toString();
    }

    private void notifyError(final String message) {
        mainHandler.post(() -> webView.evaluateJavascript(
            "window.onRS485Error && window.onRS485Error('" + escapeJs(message) + "')",
            null
        ));
    }

    private synchronized Object getZysjManager() {
        if (zysjManager != null) {
            return zysjManager;
        }

        try {
            Object manager = getSystemService("zysj");
            if (manager == null) {
                throw new IllegalStateException("zysj service unavailable");
            }

            zysjManager = manager;
            lastZysjError = "OK";
            return manager;
        } catch (Exception error) {
            lastZysjError = error.getMessage() != null ? error.getMessage() : "ZYSJ_UNAVAILABLE";
            Log.w(TAG, "Failed to resolve zysj service: " + lastZysjError, error);
            return null;
        }
    }

    private String buildMethodSignature(String methodName, Class<?>[] parameterTypes) {
        StringBuilder builder = new StringBuilder(methodName).append('(');
        for (int index = 0; index < parameterTypes.length; index++) {
            if (index > 0) {
                builder.append(',');
            }
            builder.append(parameterTypes[index].getSimpleName());
        }
        return builder.append(')').toString();
    }

    private Method resolveZysjMethod(Object manager, String methodName, Class<?>[] parameterTypes) throws Exception {
        String signature = buildMethodSignature(methodName, parameterTypes);
        Method cached = zysjMethodCache.get(signature);
        if (cached != null) {
            return cached;
        }

        if (zysjMissingMethods.contains(signature)) {
            throw new NoSuchMethodException(signature + " unavailable on " + manager.getClass().getName());
        }

        Method resolved = null;

        try {
            resolved = manager.getClass().getMethod(methodName, parameterTypes);
        } catch (NoSuchMethodException ignored) {
            Class<?> currentClass = manager.getClass();
            while (currentClass != null && resolved == null) {
                try {
                    resolved = currentClass.getDeclaredMethod(methodName, parameterTypes);
                } catch (NoSuchMethodException innerIgnored) {
                    currentClass = currentClass.getSuperclass();
                }
            }
        }

        if (resolved == null) {
            zysjMissingMethods.add(signature);
            throw new NoSuchMethodException(signature + " unavailable on " + manager.getClass().getName());
        }

        resolved.setAccessible(true);
        zysjMethodCache.put(signature, resolved);
        return resolved;
    }

    private Object invokeZysj(String methodName, Class<?>[] parameterTypes, Object... args) throws Exception {
        Object manager = getZysjManager();
        if (manager == null) {
            throw new IllegalStateException(lastZysjError);
        }

        Method method = resolveZysjMethod(manager, methodName, parameterTypes);
        return method.invoke(manager, args);
    }

    private int invokeZysjInt(String methodName, Class<?>[] parameterTypes, Object... args) {
        return invokeZysjInt(methodName, Integer.MIN_VALUE, true, parameterTypes, args);
    }

    private int invokeZysjInt(String methodName, int fallbackValue, boolean logFailures, Class<?>[] parameterTypes, Object... args) {
        try {
            Object value = invokeZysj(methodName, parameterTypes, args);
            if (value instanceof Integer) {
                lastZysjError = "OK";
                return (Integer) value;
            }

            if (value == null) {
                lastZysjError = methodName + " returned null";
                return fallbackValue;
            }

            lastZysjError = "OK";
            return Integer.parseInt(String.valueOf(value));
        } catch (Exception error) {
            lastZysjError = error.getMessage() != null ? error.getMessage() : methodName + " failed";
            if (logFailures) {
                Log.w(TAG, "ZYSJ int call failed for " + methodName + ": " + lastZysjError, error);
            }
            return fallbackValue;
        }
    }

    private boolean invokeZysjVoid(String methodName, Class<?>[] parameterTypes, Object... args) {
        return invokeZysjVoid(methodName, true, parameterTypes, args);
    }

    private boolean invokeZysjVoid(String methodName, boolean logFailures, Class<?>[] parameterTypes, Object... args) {
        try {
            invokeZysj(methodName, parameterTypes, args);
            lastZysjError = "OK";
            return true;
        } catch (Exception error) {
            lastZysjError = error.getMessage() != null ? error.getMessage() : methodName + " failed";
            if (logFailures) {
                Log.w(TAG, "ZYSJ void call failed for " + methodName + ": " + lastZysjError, error);
            }
            return false;
        }
    }

    public class RS485Bridge {

        @JavascriptInterface
        public void sendRS485(String hexFrame) {
            new Thread(() -> {
                try {
                    if (serialOut == null || !serialOpen) {
                        notifyError("SERIAL_NOT_OPEN");
                        return;
                    }

                    String[] parts = hexFrame == null ? new String[0] : hexFrame.trim().split("\\s+");
                    if (parts.length != 5) {
                        throw new IllegalArgumentException("INVALID_FRAME_LENGTH");
                    }

                    byte[] frame = new byte[5];
                    for (int i = 0; i < parts.length; i++) {
                        if (!parts[i].matches("(?i)[0-9a-f]{2}")) {
                            throw new IllegalArgumentException("INVALID_FRAME_BYTE");
                        }
                        frame[i] = (byte) Integer.parseInt(parts[i], 16);
                    }

                    byte expectedBcc = (byte) (frame[0] ^ frame[1] ^ frame[2] ^ frame[3]);
                    if (frame[4] != expectedBcc) {
                        throw new IllegalArgumentException("INVALID_FRAME_BCC");
                    }

                    serialFrameParser.expectResponseFor(frame);
                    serialOut.write(frame);
                    serialOut.flush();
                    Log.d(TAG, "TX -> " + hexFrame);
                } catch (Exception error) {
                    notifyError("SEND_FAILED: " + error.getMessage());
                }
            }).start();
        }

        @JavascriptInterface
        public void unlockChannel(int boardAddr, int channel) {
            byte bcc = (byte) (0x8A ^ boardAddr ^ channel ^ 0x33);
            String hex = String.format("8A %02X %02X 33 %02X", boardAddr, channel, bcc & 0xFF);
            sendRS485(hex);
        }

        @JavascriptInterface
        public void readAllStatus(int boardAddr) {
            byte bcc = (byte) (0x80 ^ boardAddr ^ 0x00 ^ 0x33);
            String hex = String.format("80 %02X 00 33 %02X", boardAddr, bcc & 0xFF);
            sendRS485(hex);
        }

        @JavascriptInterface
        public void setActiveFeedback(int boardAddr, boolean enable) {
            byte state = enable ? (byte) 0x01 : 0x00;
            byte channel = 0x01;
            byte bcc = (byte) (0x8D ^ boardAddr ^ channel ^ state);
            String hex = String.format(
                "8D %02X %02X %02X %02X",
                boardAddr,
                channel & 0xFF,
                state & 0xFF,
                bcc & 0xFF
            );
            sendRS485(hex);
        }

        @JavascriptInterface
        public void queryFirmware(int boardAddr) {
            byte bcc = (byte) (0x82 ^ boardAddr ^ 0x00 ^ 0x22);
            String hex = String.format("82 %02X 00 22 %02X", boardAddr, bcc & 0xFF);
            sendRS485(hex);
        }

        @JavascriptInterface
        public String getBridgeVersion() {
            return "PREDDITA-BRIDGE-1.5.0";
        }

        @JavascriptInterface
        public boolean isSerialOpen() {
            return serialOpen && serialOut != null;
        }

        @JavascriptInterface
        public String getSerialPath() {
            return activeSerialPort;
        }

        @JavascriptInterface
        public String getLastSerialError() {
            return lastSerialError;
        }

        @JavascriptInterface
        public void retrySerial() {
            initSerial();
        }

        @JavascriptInterface
        public boolean isZysjAvailable() {
            lastZysjError = "ZYSJ_DISABLED_SAFE_MODE";
            return false;
        }

        @JavascriptInterface
        public int getZysjGpioValue(int pin) {
            lastZysjError = "ZYSJ_DISABLED_SAFE_MODE";
            return Integer.MIN_VALUE;
        }

        @JavascriptInterface
        public int setZysjGpioValue(int pin, int value) {
            lastZysjError = "ZYSJ_DISABLED_SAFE_MODE";
            return Integer.MIN_VALUE;
        }

        @JavascriptInterface
        public int pulseZysjGpio(int pin, int holdMs) {
            int onResult = setZysjGpioValue(pin, 1);
            if (onResult == Integer.MIN_VALUE) {
                return onResult;
            }

            try {
                Thread.sleep(Math.max(60, Math.min(holdMs, 3000)));
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }

            return setZysjGpioValue(pin, 0);
        }

        @JavascriptInterface
        public int getZysjMcuVersion() {
            lastZysjError = "ZYSJ_DISABLED_SAFE_MODE";
            return Integer.MIN_VALUE;
        }

        @JavascriptInterface
        public int getZysjOutputChannel() {
            lastZysjError = "ZYSJ_DISABLED_SAFE_MODE";
            return Integer.MIN_VALUE;
        }

        @JavascriptInterface
        public boolean setZysjOutputChannel(int channel) {
            lastZysjError = "ZYSJ_DISABLED_SAFE_MODE";
            return false;
        }

        @JavascriptInterface
        public String getZysjGpioSnapshot() {
            lastZysjError = "ZYSJ_DISABLED_SAFE_MODE";
            return "";
        }

        @JavascriptInterface
        public String getLastZysjError() {
            return lastZysjError;
        }
    }
}
