package com.preddita.entregaslocker;

import android.annotation.SuppressLint;
import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.media.AudioManager;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.StatFs;
import android.util.Log;
import android.text.InputType;
import android.view.View;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
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
import java.util.concurrent.atomic.AtomicLong;

/**
 * PREDDITA Smart Locker - MainActivity
 *
 * Responsibilities:
 *  1. Render the React app inside a fullscreen WebView
 *  2. Expose an Android -> JavaScript bridge for RS-485 commands
 *  3. Keep device credentials inside Android Keystore and sign device requests
 *  4. Probe common serial ports used by the KS1062 and keep the active one open
 */
public class MainActivity extends Activity {

    private static final String TAG = "PredditaLocker";
    private static final String KIOSK_ORIGIN = "https://appassets.androidplatform.net";
    private static final String KIOSK_ASSET_PATH = "/assets/www/";
    private static final String KIOSK_URL = KIOSK_ORIGIN + KIOSK_ASSET_PATH + "index.html";
    private static final int CAMERA_PERMISSION_REQUEST = 4201;
    private static final int BAUD_RATE = 9600;
    private static final long DIAGNOSTIC_SESSION_MS = 5L * 60L * 1000L;
    private static final long DIAGNOSTIC_LOCKOUT_MS = 60L * 1000L;
    private static final long SERIAL_RESPONSE_TIMEOUT_MS = 900L;
    private static final long SERIAL_RECOVERY_BACKOFF_MS = 250L;
    private static final long SERIAL_RECOVERY_WAIT_MS = 1800L;
    private static final int SERIAL_QUEUE_CAPACITY = 32;
    private static final String TECHNICAL_PREFERENCES = "preddita_technical_controls_v1";
    private static final String PREF_DIAGNOSTIC_FAILED_ATTEMPTS = "diagnosticFailedAttempts";
    private static final String PREF_DIAGNOSTIC_LOCKED_UNTIL = "diagnosticLockedUntil";
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
    private volatile Thread serialThread;
    private final Rs485FrameParser serialFrameParser = new Rs485FrameParser();
    private final Object serialWriteLock = new Object();
    private final AtomicLong legacySerialExecution = new AtomicLong();
    private SerialCommandCoordinator serialCoordinator;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private DeviceCredentialStore deviceCredentialStore;
    private DiagnosticCredentialStore diagnosticCredentialStore;
    private SharedPreferences technicalPreferences;
    private AppUpdateManager appUpdateManager;
    private volatile String lastDeviceAuthError = "";

    private volatile boolean serialOpen = false;
    private volatile String activeSerialPort = SERIAL_PORT_CANDIDATES[0];
    private volatile String lastSerialError = "INIT_PENDING";
    private volatile String lastSerialFrameAt = "";
    private volatile int serialReconnectCount = -1;
    private volatile long diagnosticAuthorizedUntilMs = 0L;
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
        deviceCredentialStore = new DeviceCredentialStore(getApplicationContext());
        diagnosticCredentialStore = new DiagnosticCredentialStore(getApplicationContext());
        technicalPreferences = getSharedPreferences(TECHNICAL_PREFERENCES, MODE_PRIVATE);
        appUpdateManager = new AppUpdateManager(this, this::dispatchAppUpdateStatus);
        appUpdateManager.reportAppStarted(deviceCredentialStore.isProvisioned());
        serialCoordinator = createSerialCoordinator();
        applyPersistedTechnicalControls();

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
        webView.addJavascriptInterface(new DeviceAuthBridge(), "PredditaDeviceAuth");
        webView.addJavascriptInterface(new AppUpdateBridge(), "PredditaUpdater");
        webView.addJavascriptInterface(new TechnicalDiagnosticsBridge(), "PredditaDiagnostics");
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

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (isAllowedKioskUrl(url)) appUpdateManager.reportWebViewReady();
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

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void addProvisioningField(LinearLayout form, String label, EditText input) {
        TextView fieldLabel = new TextView(this);
        fieldLabel.setText(label);
        fieldLabel.setTextSize(14);
        form.addView(fieldLabel);
        form.addView(input, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ));
    }

    private EditText newProvisioningInput(int inputType, String value) {
        EditText input = new EditText(this);
        input.setInputType(inputType);
        input.setText(value == null ? "" : value);
        input.setSingleLine(true);
        input.setPadding(0, dp(2), 0, dp(12));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            input.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        }
        return input;
    }

    private void showDeviceProvisioningDialog(String suggestedBaseUrl, String suggestedLockerId) {
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(dp(24), dp(8), dp(24), 0);

        EditText baseUrlInput = newProvisioningInput(
            InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI,
            deviceCredentialStore.getBaseUrl().isEmpty() ? suggestedBaseUrl : deviceCredentialStore.getBaseUrl()
        );
        EditText lockerIdInput = newProvisioningInput(
            InputType.TYPE_CLASS_TEXT,
            deviceCredentialStore.getLockerId().isEmpty() ? suggestedLockerId : deviceCredentialStore.getLockerId()
        );
        EditText deviceKeyInput = newProvisioningInput(
            InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD,
            ""
        );
        deviceKeyInput.setHint("Minimo de 32 caracteres");
        EditText diagnosticPinInput = newProvisioningInput(
            InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD,
            ""
        );
        diagnosticPinInput.setHint(
            diagnosticCredentialStore.isProvisioned()
                ? "Deixe vazio para manter o PIN atual"
                : "8 a 12 digitos"
        );

        addProvisioningField(form, "URL HTTPS do Admin Online", baseUrlInput);
        addProvisioningField(form, "Identificador do locker", lockerIdInput);
        addProvisioningField(form, "Chave HMAC do dispositivo", deviceKeyInput);
        addProvisioningField(form, "PIN tecnico local", diagnosticPinInput);

        AlertDialog dialog = new AlertDialog.Builder(this)
            .setTitle("Provisionar conexao segura")
            .setView(form)
            .setNegativeButton("Cancelar", null)
            .setPositiveButton("Salvar", null)
            .create();

        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            try {
                String rawDiagnosticPin = diagnosticPinInput.getText().toString().trim();
                if (!diagnosticCredentialStore.isProvisioned() || !rawDiagnosticPin.isEmpty()) {
                    DiagnosticControlContract.normalizeTechnicalPin(rawDiagnosticPin);
                }
                deviceCredentialStore.provision(
                    baseUrlInput.getText().toString(),
                    lockerIdInput.getText().toString(),
                    deviceKeyInput.getText().toString(),
                    isDebuggableBuild()
                );
                appUpdateManager.reportAppStarted(true);
                if (!rawDiagnosticPin.isEmpty()) {
                    diagnosticCredentialStore.provision(rawDiagnosticPin);
                }
                lastDeviceAuthError = "";
                deviceKeyInput.getText().clear();
                diagnosticPinInput.getText().clear();
                webView.evaluateJavascript(
                    "window.dispatchEvent(new Event('preddita-device-auth-changed'));"
                        + "window.dispatchEvent(new Event('preddita-diagnostic-credential-changed'))",
                    null
                );
                Toast.makeText(this, "Conexao e PIN tecnico protegidos no Android.", Toast.LENGTH_LONG).show();
                dialog.dismiss();
            } catch (Exception error) {
                lastDeviceAuthError = error.getMessage() != null ? error.getMessage() : "PROVISIONING_FAILED";
                Toast.makeText(this, lastDeviceAuthError, Toast.LENGTH_LONG).show();
            }
        }));
        dialog.setOnDismissListener(ignored -> {
            deviceKeyInput.getText().clear();
            diagnosticPinInput.getText().clear();
        });
        dialog.show();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (appUpdateManager != null) appUpdateManager.resumePendingInstall();
    }

    @Override
    protected void onDestroy() {
        if (appUpdateManager != null) appUpdateManager.shutdown();
        if (serialCoordinator != null) serialCoordinator.shutdown();
        stopSerialThread();
        closeSerialStreams();
        super.onDestroy();
    }

    private void dispatchAppUpdateStatus(String statusJson) {
        mainHandler.post(() -> {
            if (webView == null) return;
            String encoded = org.json.JSONObject.quote(statusJson == null ? "{}" : statusJson);
            webView.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('preddita-update-status',{detail:JSON.parse(" + encoded + ")}))",
                null
            );
        });
    }

    private synchronized void initSerial() {
        serialReconnectCount += 1;
        serialCoordinator.markDriverStarting();
        stopSerialThread();
        closeSerialStreams();
        serialThread = new Thread(this::openAndReadSerial, "preddita-serial");
        serialThread.start();
    }

    private void openAndReadSerial() {
        Thread currentThread = Thread.currentThread();
        try {
            String openedPort = openFirstAvailablePort();
            if (openedPort == null) {
                throw new IOException(lastSerialError);
            }

            FileInputStream input;
            synchronized (this) {
                if (currentThread != serialThread || currentThread.isInterrupted()) {
                    throw new IOException("SERIAL_OPEN_CANCELLED");
                }
                input = serialIn;
                if (input == null) throw new IOException("SERIAL_INPUT_UNAVAILABLE");
                serialOpen = true;
                serialFrameParser.reset();
                activeSerialPort = openedPort;
                lastSerialError = "OK";
            }
            serialCoordinator.markDriverReady();
            appUpdateManager.reportSerialHealth(true, true, "");
            Log.i(TAG, "Serial port opened on " + openedPort + " at " + BAUD_RATE + " bps");

            byte[] buffer = new byte[32];
            while (!Thread.currentThread().isInterrupted()) {
                int size = input.read(buffer);
                if (size > 0) {
                    long invalidBefore = serialFrameParser.invalidFrameCount();
                    long discardedBefore = serialFrameParser.discardedByteCount();
                    List<byte[]> frames = serialFrameParser.append(buffer, size);
                    serialCoordinator.recordParserActivity(
                        serialFrameParser.invalidFrameCount() - invalidBefore,
                        serialFrameParser.discardedByteCount() - discardedBefore
                    );
                    for (byte[] frame : frames) {
                        final String hex = formatHexFrame(frame);
                        lastSerialFrameAt = java.time.Instant.now().toString();
                        Log.d(TAG, "RX <- " + hex);
                        serialCoordinator.onFrame(frame);
                    }
                }
            }
        } catch (Exception error) {
            boolean activeFailure = currentThread == serialThread && !currentThread.isInterrupted();
            if (activeFailure) {
                closeSerialStreams();
                lastSerialError = error.getMessage() != null ? error.getMessage() : "SERIAL_OPEN_FAILED";
                Log.e(TAG, "Serial error: " + lastSerialError, error);
                serialCoordinator.onDriverFailure("SERIAL_IO_FAILURE");
                appUpdateManager.reportSerialHealth(true, false, "SERIAL_IO_FAILURE");
            }
        }
    }

    private SerialCommandCoordinator createSerialCoordinator() {
        return new SerialCommandCoordinator(
            new SerialCommandCoordinator.Transport() {
                @Override
                public boolean isAvailable() {
                    return serialOpen && serialOut != null;
                }

                @Override
                public void write(byte[] frame) throws Exception {
                    writeSerialFrame(frame);
                }

                @Override
                public boolean recover() {
                    return recoverSerialTransport();
                }
            },
            this::dispatchSerialCommandResult,
            SERIAL_QUEUE_CAPACITY,
            SERIAL_RESPONSE_TIMEOUT_MS,
            SERIAL_RECOVERY_BACKOFF_MS
        );
    }

    private void writeSerialFrame(byte[] frame) throws IOException {
        synchronized (serialWriteLock) {
            FileOutputStream output = serialOut;
            if (!serialOpen || output == null) throw new IOException("SERIAL_NOT_OPEN");
            serialFrameParser.expectResponseFor(frame);
            output.write(frame);
            output.flush();
            Log.d(TAG, "TX -> " + formatHexFrame(frame));
        }
    }

    private boolean recoverSerialTransport() {
        initSerial();
        long deadline = System.currentTimeMillis() + SERIAL_RECOVERY_WAIT_MS;
        while (System.currentTimeMillis() < deadline) {
            if (serialOpen && serialOut != null) return true;
            try {
                Thread.sleep(50L);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
                return false;
            }
        }
        return serialOpen && serialOut != null;
    }

    private String openFirstAvailablePort() {
        StringBuilder attempts = new StringBuilder();

        for (String candidate : SERIAL_PORT_CANDIDATES) {
            FileOutputStream candidateOut = null;
            FileInputStream candidateIn = null;
            try {
                preparePort(candidate);
                candidateOut = new FileOutputStream(candidate);
                candidateIn = new FileInputStream(candidate);
                synchronized (this) {
                    if (Thread.currentThread() != serialThread || Thread.currentThread().isInterrupted()) {
                        throw new IOException("SERIAL_OPEN_CANCELLED");
                    }
                    synchronized (serialWriteLock) {
                        serialOut = candidateOut;
                        serialIn = candidateIn;
                    }
                }
                return candidate;
            } catch (Exception error) {
                closeQuietly(candidateOut);
                closeQuietly(candidateIn);
                if (Thread.currentThread() != serialThread || Thread.currentThread().isInterrupted()) {
                    return null;
                }
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

    private void closeQuietly(java.io.Closeable closeable) {
        if (closeable == null) return;
        try {
            closeable.close();
        } catch (IOException ignored) {
        }
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
        synchronized (serialWriteLock) {
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

    private byte[] parseSerialRequest(String hexFrame) {
        String[] parts = hexFrame == null ? new String[0] : hexFrame.trim().split("\\s+");
        if (parts.length != 5) throw new IllegalArgumentException("INVALID_FRAME_LENGTH");
        byte[] frame = new byte[5];
        for (int index = 0; index < parts.length; index++) {
            if (!parts[index].matches("(?i)[0-9a-f]{2}")) {
                throw new IllegalArgumentException("INVALID_FRAME_BYTE");
            }
            frame[index] = (byte) Integer.parseInt(parts[index], 16);
        }
        return frame;
    }

    private void dispatchSerialCommandResult(SerialCommandCoordinator.Result result) {
        try {
            String responseHex = result.getResponse() == null
                ? ""
                : formatHexFrame(result.getResponse());
            if (result.getExecutionId().startsWith("legacy-")) {
                String callback = result.isOk()
                    ? "window.onRS485Response && window.onRS485Response('" + escapeJs(responseHex) + "')"
                    : "window.onRS485Error && window.onRS485Error('" + escapeJs(result.getErrorCode()) + "')";
                mainHandler.post(() -> webView.evaluateJavascript(callback, null));
                return;
            }

            org.json.JSONObject payload = new org.json.JSONObject()
                .put("executionId", result.getExecutionId())
                .put("operation", result.getOperationKind() == null
                    ? "unknown"
                    : result.getOperationKind().name().toLowerCase(java.util.Locale.ROOT))
                .put("ok", result.isOk())
                .put("error", result.getErrorCode())
                .put("hex", responseHex)
                .put("attempts", result.getAttempts())
                .put("queueWaitMs", result.getQueueWaitMs())
                .put("durationMs", result.getDurationMs())
                .put("executionOutcomeUnknown", result.isExecutionOutcomeUnknown());
            String encoded = org.json.JSONObject.quote(payload.toString());
            mainHandler.post(() -> webView.evaluateJavascript(
                "window.onRS485CommandResult && window.onRS485CommandResult(JSON.parse(" + encoded + "))",
                null
            ));
        } catch (Exception error) {
            Log.e(TAG, "Serial result dispatch failed", error);
        }
    }

    private org.json.JSONObject buildSerialCoordinatorMetricsJson() throws org.json.JSONException {
        SerialCommandCoordinator.Metrics metrics = serialCoordinator.snapshotMetrics();
        String lastResponseAt = metrics.lastValidResponseAtMs > 0L
            ? java.time.Instant.ofEpochMilli(metrics.lastValidResponseAtMs).toString()
            : "";
        return new org.json.JSONObject()
            .put("state", metrics.state)
            .put("queueDepth", metrics.queueDepth)
            .put("maxQueueDepth", metrics.maxQueueDepth)
            .put("inFlight", metrics.inFlight)
            .put("blockedActuations", metrics.blockedActuations)
            .put("submitted", metrics.submitted)
            .put("completed", metrics.completed)
            .put("rejected", metrics.rejected)
            .put("writes", metrics.writes)
            .put("readRetries", metrics.readRetries)
            .put("timeouts", metrics.timeouts)
            .put("invalidFrames", metrics.invalidFrames)
            .put("discardedBytes", metrics.discardedBytes)
            .put("mismatchedFrames", metrics.mismatchedFrames)
            .put("reconnections", metrics.reconnections)
            .put("ioFailures", metrics.ioFailures)
            .put("unknownActuations", metrics.unknownActuations)
            .put("lastQueueWaitMs", metrics.lastQueueWaitMs)
            .put("maxQueueWaitMs", metrics.maxQueueWaitMs)
            .put("lastValidResponseAt", lastResponseAt);
    }

    private boolean isDiagnosticAuthorized(boolean extend) {
        long now = System.currentTimeMillis();
        if (diagnosticAuthorizedUntilMs <= now) {
            diagnosticAuthorizedUntilMs = 0L;
            return false;
        }
        if (extend) diagnosticAuthorizedUntilMs = now + DIAGNOSTIC_SESSION_MS;
        return true;
    }

    private void applyPersistedTechnicalControls() {
        int brightness = technicalPreferences.getInt("brightnessPercent", 70);
        int volume = technicalPreferences.getInt("mediaVolumePercent", 45);
        boolean keepScreenOn = technicalPreferences.getBoolean("keepScreenOn", true);
        applyBrightness(brightness);
        applyMediaVolume(volume);
        applyKeepScreenOn(keepScreenOn);
    }

    private boolean applyBrightness(int percent) {
        if (!DiagnosticControlContract.isBrightnessAllowed(percent)) return false;
        WindowManager.LayoutParams attributes = getWindow().getAttributes();
        attributes.screenBrightness = percent / 100f;
        getWindow().setAttributes(attributes);
        technicalPreferences.edit().putInt("brightnessPercent", percent).apply();
        return true;
    }

    private boolean applyMediaVolume(int percent) {
        if (!DiagnosticControlContract.isVolumeAllowed(percent)) return false;
        AudioManager audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        if (audioManager == null) return false;
        int maximum = Math.max(1, audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC));
        int target = Math.round(maximum * (percent / 100f));
        audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, target, 0);
        technicalPreferences.edit().putInt("mediaVolumePercent", percent).apply();
        return true;
    }

    private boolean applyKeepScreenOn(boolean enabled) {
        if (enabled) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
        technicalPreferences.edit().putBoolean("keepScreenOn", enabled).apply();
        return true;
    }

    private String getNetworkTransport() {
        ConnectivityManager manager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager == null) return "unknown";
        NetworkCapabilities capabilities = manager.getNetworkCapabilities(manager.getActiveNetwork());
        if (capabilities == null) return "offline";
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) return "ethernet";
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return "wifi";
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) return "cellular";
        return "other";
    }

    private boolean isNetworkOnline() {
        ConnectivityManager manager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager == null) return false;
        NetworkCapabilities capabilities = manager.getNetworkCapabilities(manager.getActiveNetwork());
        return capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    private String buildTechnicalStatusJson() {
        if (!isDiagnosticAuthorized(true)) {
            return "{\"available\":true,\"authorized\":false,\"errorCode\":\"SESSION_REQUIRED\"}";
        }
        try {
            StatFs storage = new StatFs(getFilesDir().getAbsolutePath());
            AudioManager audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            int maxVolume = audioManager == null ? 1 : Math.max(1, audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC));
            int currentVolume = audioManager == null ? 0 : audioManager.getStreamVolume(AudioManager.STREAM_MUSIC);
            int mediaVolumePercent = Math.round(currentVolume * 100f / maxVolume);
            int brightnessPercent = technicalPreferences.getInt("brightnessPercent", 70);
            boolean keepScreenOn = technicalPreferences.getBoolean("keepScreenOn", true);
            android.content.pm.PackageInfo packageInfo = getPackageManager().getPackageInfo(getPackageName(), 0);
            long versionCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? packageInfo.getLongVersionCode()
                : packageInfo.versionCode;
            boolean hasCamera = getPackageManager().hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY);

            org.json.JSONObject serial = new org.json.JSONObject()
                .put("open", serialOpen && serialOut != null)
                .put("path", activeSerialPort)
                .put("baudRate", BAUD_RATE)
                .put("reconnectCount", Math.max(0, serialReconnectCount))
                .put("lastFrameAt", lastSerialFrameAt)
                .put("errorCode", DiagnosticControlContract.serialErrorCode(serialOpen, lastSerialError))
                .put("coordinator", buildSerialCoordinatorMetricsJson());
            org.json.JSONObject network = new org.json.JSONObject()
                .put("online", isNetworkOnline())
                .put("transport", getNetworkTransport());
            org.json.JSONObject camera = new org.json.JSONObject()
                .put("available", hasCamera)
                .put("permission", hasCameraPermission() ? "granted" : "denied");
            org.json.JSONObject display = new org.json.JSONObject()
                .put("brightnessPercent", brightnessPercent)
                .put("mediaVolumePercent", mediaVolumePercent)
                .put("keepScreenOn", keepScreenOn);
            org.json.JSONObject storageJson = new org.json.JSONObject()
                .put("freeBytes", storage.getAvailableBytes())
                .put("totalBytes", storage.getTotalBytes());
            org.json.JSONObject app = new org.json.JSONObject()
                .put("versionName", packageInfo.versionName == null ? "" : packageInfo.versionName)
                .put("versionCode", versionCode);

            return new org.json.JSONObject()
                .put("available", true)
                .put("authorized", true)
                .put("serial", serial)
                .put("network", network)
                .put("camera", camera)
                .put("display", display)
                .put("storage", storageJson)
                .put("app", app)
                .put("errorCode", "")
                .toString();
        } catch (Exception error) {
            Log.e(TAG, "Technical status failed", error);
            return "{\"available\":true,\"authorized\":true,\"errorCode\":\"STATUS_UNAVAILABLE\"}";
        }
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

    public class TechnicalDiagnosticsBridge {
        @JavascriptInterface
        public String getCredentialStatus() {
            return diagnosticCredentialStore.getStatusJson(
                technicalPreferences.getLong(PREF_DIAGNOSTIC_LOCKED_UNTIL, 0L)
            );
        }

        @JavascriptInterface
        public boolean verifyPin(String pin) {
            long now = System.currentTimeMillis();
            long lockedUntilMs = technicalPreferences.getLong(PREF_DIAGNOSTIC_LOCKED_UNTIL, 0L);
            if (lockedUntilMs > now) return false;
            if (diagnosticCredentialStore.verify(pin)) {
                technicalPreferences.edit()
                    .remove(PREF_DIAGNOSTIC_FAILED_ATTEMPTS)
                    .remove(PREF_DIAGNOSTIC_LOCKED_UNTIL)
                    .commit();
                diagnosticAuthorizedUntilMs = now + DIAGNOSTIC_SESSION_MS;
                Log.i(TAG, "Technical session authorized locally");
                return true;
            }

            int failedAttempts = technicalPreferences.getInt(PREF_DIAGNOSTIC_FAILED_ATTEMPTS, 0) + 1;
            SharedPreferences.Editor failureEditor = technicalPreferences.edit();
            if (failedAttempts >= 5) {
                failureEditor
                    .remove(PREF_DIAGNOSTIC_FAILED_ATTEMPTS)
                    .putLong(PREF_DIAGNOSTIC_LOCKED_UNTIL, now + DIAGNOSTIC_LOCKOUT_MS)
                    .commit();
                Log.w(TAG, "Technical credential temporarily locked after failed attempts");
            } else {
                failureEditor.putInt(PREF_DIAGNOSTIC_FAILED_ATTEMPTS, failedAttempts).commit();
            }
            return false;
        }

        @JavascriptInterface
        public void openProvisioning() {
            mainHandler.post(() -> showDeviceProvisioningDialog(
                deviceCredentialStore.getBaseUrl(),
                deviceCredentialStore.getLockerId()
            ));
        }

        @JavascriptInterface
        public void endSession() {
            diagnosticAuthorizedUntilMs = 0L;
            Log.i(TAG, "Technical session ended locally");
        }

        @JavascriptInterface
        public String getStatus() {
            return buildTechnicalStatusJson();
        }

        @JavascriptInterface
        public boolean setBrightnessPercent(int percent) {
            if (!isDiagnosticAuthorized(true) || !DiagnosticControlContract.isBrightnessAllowed(percent)) {
                return false;
            }
            technicalPreferences.edit().putInt("brightnessPercent", percent).apply();
            mainHandler.post(() -> applyBrightness(percent));
            Log.i(TAG, "Technical brightness adjustment accepted");
            return true;
        }

        @JavascriptInterface
        public boolean setMediaVolumePercent(int percent) {
            if (!isDiagnosticAuthorized(true) || !DiagnosticControlContract.isVolumeAllowed(percent)) {
                return false;
            }
            technicalPreferences.edit().putInt("mediaVolumePercent", percent).apply();
            mainHandler.post(() -> applyMediaVolume(percent));
            Log.i(TAG, "Technical media volume adjustment accepted");
            return true;
        }

        @JavascriptInterface
        public boolean setKeepScreenOn(boolean enabled) {
            if (!isDiagnosticAuthorized(true)) return false;
            technicalPreferences.edit().putBoolean("keepScreenOn", enabled).apply();
            mainHandler.post(() -> applyKeepScreenOn(enabled));
            Log.i(TAG, "Technical keep-screen-on adjustment accepted");
            return true;
        }

        @JavascriptInterface
        public boolean retrySerial() {
            if (!isDiagnosticAuthorized(true)) return false;
            new Thread(MainActivity.this::initSerial, "preddita-serial-retry").start();
            Log.i(TAG, "Technical serial reconnect requested");
            return true;
        }
    }

    public class DeviceAuthBridge {
        @JavascriptInterface
        public String getConfig() {
            return deviceCredentialStore.getConfigJson();
        }

        @JavascriptInterface
        public String signRequest(
            String method,
            String path,
            String timestamp,
            String nonce,
            String contentSha256
        ) {
            try {
                String signature = deviceCredentialStore.signRequest(
                    method,
                    path,
                    timestamp,
                    nonce,
                    contentSha256
                );
                lastDeviceAuthError = "";
                return signature;
            } catch (Exception error) {
                lastDeviceAuthError = error.getMessage() != null ? error.getMessage() : "DEVICE_SIGN_FAILED";
                Log.w(TAG, "Device request signing failed: " + lastDeviceAuthError);
                return "";
            }
        }

        @JavascriptInterface
        public String getLastError() {
            return lastDeviceAuthError;
        }

        @JavascriptInterface
        public void openProvisioning(String suggestedBaseUrl, String suggestedLockerId) {
            mainHandler.post(() -> showDeviceProvisioningDialog(suggestedBaseUrl, suggestedLockerId));
        }
    }

    public class AppUpdateBridge {
        @JavascriptInterface
        public String getStatus() {
            return appUpdateManager.getStatusJson();
        }

        @JavascriptInterface
        public boolean requestUpdate(String manifestJson) {
            return appUpdateManager.requestUpdate(manifestJson);
        }

        @JavascriptInterface
        public void reportHealth(String healthJson) {
            appUpdateManager.reportRuntimeHealth(healthJson);
        }
    }

    public class RS485Bridge {

        @JavascriptInterface
        public void sendRS485(String hexFrame) {
            String executionId = "legacy-" + legacySerialExecution.incrementAndGet();
            sendRS485Command(executionId, hexFrame);
        }

        @JavascriptInterface
        public boolean sendRS485Command(String executionId, String hexFrame) {
            try {
                return serialCoordinator.submit(executionId, parseSerialRequest(hexFrame));
            } catch (IllegalArgumentException error) {
                return serialCoordinator.submit(executionId, new byte[0]);
            }
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
            return "PREDDITA-BRIDGE-1.8.0";
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
        public String getSerialCoordinatorStatus() {
            try {
                return buildSerialCoordinatorMetricsJson().toString();
            } catch (Exception error) {
                return "{\"state\":\"UNAVAILABLE\"}";
            }
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
