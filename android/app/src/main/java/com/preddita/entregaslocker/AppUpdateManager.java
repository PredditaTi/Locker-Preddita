package com.preddita.entregaslocker;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.util.Log;

import androidx.core.content.FileProvider;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public final class AppUpdateManager {
    public interface StatusListener {
        void onStatusChanged(String statusJson);
    }

    private static final String TAG = "PredditaUpdater";
    private static final String PREFERENCES = "preddita_app_updater_v1";
    private static final long MAX_APK_BYTES = 250L * 1024L * 1024L;
    private static final int MAX_REDIRECTS = 5;
    private static final int CONNECT_TIMEOUT_MS = 20_000;
    private static final int READ_TIMEOUT_MS = 30_000;
    private static final long FAILURE_RETRY_COOLDOWN_MS = 15L * 60L * 1000L;

    private final Activity activity;
    private final SharedPreferences preferences;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean updateInFlight = new AtomicBoolean(false);
    private final StatusListener listener;

    public AppUpdateManager(Activity activity, StatusListener listener) {
        this.activity = activity;
        this.listener = listener;
        this.preferences = activity.getSharedPreferences(PREFERENCES, Activity.MODE_PRIVATE);
    }

    public String getStatusJson() {
        long currentVersionCode = getCurrentVersionCode();
        long targetVersionCode = preferences.getLong("targetVersionCode", 0);
        String status = preferences.getString("status", "idle");
        if (targetVersionCode > 0 && currentVersionCode >= targetVersionCode && !"up-to-date".equals(status)) {
            status = "up-to-date";
            preferences.edit()
                .putString("status", status)
                .putInt("progressPercentage", 100)
                .putString("lastError", "")
                .putString("updatedAt", java.time.Instant.now().toString())
                .apply();
        }
        try {
            return new JSONObject()
                .put("available", true)
                .put("currentVersionCode", currentVersionCode)
                .put("currentVersionName", getCurrentVersionName())
                .put("status", status)
                .put("releaseId", preferences.getString("releaseId", ""))
                .put("targetVersionCode", targetVersionCode)
                .put("targetVersionName", preferences.getString("targetVersionName", ""))
                .put("progressPercentage", preferences.getInt("progressPercentage", 0))
                .put("lastError", preferences.getString("lastError", ""))
                .put("updatedAt", preferences.getString("updatedAt", ""))
                .toString();
        } catch (JSONException impossible) {
            return "{\"available\":true,\"status\":\"failed\",\"lastError\":\"STATUS_ENCODING_FAILED\"}";
        }
    }

    public boolean requestUpdate(String manifestJson) {
        final UpdateManifest manifest;
        try {
            manifest = UpdateManifest.parse(manifestJson);
            validateManifest(manifest);
        } catch (Exception error) {
            fail("MANIFEST_INVALID: " + safeMessage(error));
            return false;
        }

        if (!AppUpdateContract.isUpgrade(getCurrentVersionCode(), manifest.versionCode)) {
            saveManifest(manifest);
            saveStatus("up-to-date", 100, "");
            return false;
        }
        String existingReleaseId = preferences.getString("releaseId", "");
        String existingStatus = preferences.getString("status", "idle");
        if (manifest.releaseId.equals(existingReleaseId)) {
            if (
                "downloaded".equals(existingStatus)
                || "awaiting-permission".equals(existingStatus)
                || "installing".equals(existingStatus)
                || "up-to-date".equals(existingStatus)
            ) {
                return false;
            }
            long lastAttemptAtMs = preferences.getLong("lastAttemptAtMs", 0);
            if (
                "failed".equals(existingStatus)
                && System.currentTimeMillis() - lastAttemptAtMs < FAILURE_RETRY_COOLDOWN_MS
            ) {
                return false;
            }
        }
        if (!updateInFlight.compareAndSet(false, true)) return false;

        saveManifest(manifest);
        preferences.edit().putLong("lastAttemptAtMs", System.currentTimeMillis()).apply();
        saveStatus("offered", 0, "");
        executor.execute(() -> {
            try {
                File apk = downloadAndVerify(manifest);
                preferences.edit().putString("downloadedFile", apk.getAbsolutePath()).apply();
                saveStatus("downloaded", 100, "");
                activity.runOnUiThread(() -> {
                    try {
                        requestInstall(apk);
                    } catch (Exception error) {
                        fail("INSTALL_INTENT_FAILED: " + safeMessage(error));
                    }
                });
            } catch (Exception error) {
                Log.e(TAG, "Secure update failed", error);
                fail(safeMessage(error));
            } finally {
                updateInFlight.set(false);
            }
        });
        return true;
    }

    public void resumePendingInstall() {
        String status = preferences.getString("status", "");
        if ("installing".equals(status)) {
            if (getCurrentVersionCode() < preferences.getLong("targetVersionCode", 0)) {
                fail("INSTALL_NOT_COMPLETED");
            }
            return;
        }
        if (!"awaiting-permission".equals(status) && !"downloaded".equals(status)) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.getPackageManager().canRequestPackageInstalls()) {
            return;
        }
        File apk = new File(preferences.getString("downloadedFile", ""));
        try {
            UpdateManifest manifest = UpdateManifest.fromPreferences(preferences);
            verifyDownloadedApk(apk, manifest);
            requestInstall(apk);
        } catch (Exception error) {
            fail("REVALIDATION_FAILED: " + safeMessage(error));
        }
    }

    public void shutdown() {
        executor.shutdownNow();
    }

    private File downloadAndVerify(UpdateManifest manifest) throws Exception {
        File externalDownloads = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (externalDownloads == null) throw new IOException("EXTERNAL_STORAGE_UNAVAILABLE");
        File downloadDirectory = new File(externalDownloads, "updates");
        if (!downloadDirectory.exists() && !downloadDirectory.mkdirs()) {
            throw new IOException("DOWNLOAD_DIRECTORY_UNAVAILABLE");
        }
        File temporary = new File(downloadDirectory, "preddita-update.tmp");
        File destination = new File(downloadDirectory, "preddita-" + manifest.versionCode + ".apk");
        if (temporary.exists() && !temporary.delete()) throw new IOException("TEMP_FILE_LOCKED");

        saveStatus("downloading", 0, "");
        HttpURLConnection connection = openHttpsConnection(manifest.apkUrl);
        long contentLength = connection.getContentLengthLong();
        if (contentLength > MAX_APK_BYTES) {
            connection.disconnect();
            throw new IOException("APK_TOO_LARGE");
        }

        long total = 0;
        int lastProgress = -1;
        try (BufferedInputStream input = new BufferedInputStream(connection.getInputStream());
             FileOutputStream output = new FileOutputStream(temporary)) {
            byte[] buffer = new byte[32 * 1024];
            int read;
            while ((read = input.read(buffer)) >= 0) {
                if (read == 0) continue;
                total += read;
                if (total > MAX_APK_BYTES) throw new IOException("APK_TOO_LARGE");
                output.write(buffer, 0, read);
                int progress = contentLength > 0 ? (int) Math.min(99, total * 100 / contentLength) : 0;
                if (progress >= lastProgress + 5) {
                    lastProgress = progress;
                    saveStatus("downloading", progress, "");
                }
            }
            output.getFD().sync();
        } finally {
            connection.disconnect();
        }
        if (total <= 0) throw new IOException("APK_EMPTY");
        if (destination.exists() && !destination.delete()) throw new IOException("PREVIOUS_APK_LOCKED");
        if (!temporary.renameTo(destination)) throw new IOException("APK_MOVE_FAILED");
        verifyDownloadedApk(destination, manifest);
        return destination;
    }

    private HttpURLConnection openHttpsConnection(String initialUrl) throws Exception {
        String currentUrl = initialUrl;
        for (int redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
            if (!AppUpdateContract.isValidHttpsUrl(currentUrl)) throw new IOException("NON_HTTPS_UPDATE_URL");
            HttpURLConnection connection = (HttpURLConnection) new URL(currentUrl).openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setRequestProperty("Accept", "application/vnd.android.package-archive");
            connection.setRequestProperty("User-Agent", "PREDDITA-Locker-Updater/1");
            int status = connection.getResponseCode();
            if (status >= 200 && status < 300) return connection;
            if (status >= 300 && status < 400) {
                String location = connection.getHeaderField("Location");
                URL resolved = location == null ? null : new URL(new URL(currentUrl), location);
                connection.disconnect();
                if (resolved == null) throw new IOException("UPDATE_REDIRECT_WITHOUT_LOCATION");
                currentUrl = resolved.toString();
                continue;
            }
            connection.disconnect();
            throw new IOException("UPDATE_HTTP_" + status);
        }
        throw new IOException("TOO_MANY_UPDATE_REDIRECTS");
    }

    private void verifyDownloadedApk(File apk, UpdateManifest manifest) throws Exception {
        if (!apk.isFile() || apk.length() <= 0 || apk.length() > MAX_APK_BYTES) {
            throw new IOException("APK_FILE_INVALID");
        }
        String actualSha256 = AppUpdateContract.sha256(apk);
        if (!AppUpdateContract.matchesSha256(manifest.sha256, actualSha256)) {
            throw new SecurityException("APK_SHA256_MISMATCH");
        }

        PackageManager packageManager = activity.getPackageManager();
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
            ? PackageManager.GET_SIGNING_CERTIFICATES
            : PackageManager.GET_SIGNATURES;
        PackageInfo candidate = packageManager.getPackageArchiveInfo(apk.getAbsolutePath(), flags);
        PackageInfo installed = packageManager.getPackageInfo(activity.getPackageName(), flags);
        if (candidate == null || !activity.getPackageName().equals(candidate.packageName)) {
            throw new SecurityException("APK_PACKAGE_MISMATCH");
        }
        if (
            getVersionCode(candidate) != manifest.versionCode
            || !manifest.versionName.equals(candidate.versionName)
            || !AppUpdateContract.isUpgrade(getVersionCode(installed), getVersionCode(candidate))
        ) {
            throw new SecurityException("APK_VERSION_MISMATCH");
        }
        Set<String> candidateSignatures = signatureDigests(candidate);
        Set<String> installedSignatures = signatureDigests(installed);
        if (candidateSignatures.isEmpty() || !candidateSignatures.equals(installedSignatures)) {
            throw new SecurityException("APK_SIGNATURE_MISMATCH");
        }
    }

    private void requestInstall(File apk) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.getPackageManager().canRequestPackageInstalls()) {
            saveStatus("awaiting-permission", 100, "");
            Intent permissionIntent = new Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + activity.getPackageName())
            );
            activity.startActivity(permissionIntent);
            return;
        }

        Uri apkUri = FileProvider.getUriForFile(
            activity,
            activity.getPackageName() + ".updates",
            apk
        );
        Intent installIntent = new Intent(Intent.ACTION_VIEW)
            .setDataAndType(apkUri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        saveStatus("installing", 100, "");
        activity.startActivity(installIntent);
    }

    private void validateManifest(UpdateManifest manifest) {
        if (!manifest.releaseId.matches("^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$")) {
            throw new IllegalArgumentException("RELEASE_ID_INVALID");
        }
        if (
            manifest.versionCode <= 0
            || manifest.versionCode > Integer.MAX_VALUE
            || !manifest.versionName.matches("^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$")
        ) {
            throw new IllegalArgumentException("VERSION_INVALID");
        }
        if (manifest.apkUrl.length() > 2048 || !AppUpdateContract.isValidHttpsUrl(manifest.apkUrl)) {
            throw new IllegalArgumentException("APK_URL_INVALID");
        }
        if (!AppUpdateContract.isValidSha256(manifest.sha256)) {
            throw new IllegalArgumentException("APK_SHA256_INVALID");
        }
    }

    private void saveManifest(UpdateManifest manifest) {
        preferences.edit()
            .putString("releaseId", manifest.releaseId)
            .putLong("targetVersionCode", manifest.versionCode)
            .putString("targetVersionName", manifest.versionName)
            .putString("apkUrl", manifest.apkUrl)
            .putString("sha256", manifest.sha256.toLowerCase())
            .apply();
    }

    private void saveStatus(String status, int progress, String error) {
        preferences.edit()
            .putString("status", status)
            .putInt("progressPercentage", Math.max(0, Math.min(100, progress)))
            .putString("lastError", error == null ? "" : error)
            .putString("updatedAt", java.time.Instant.now().toString())
            .apply();
        notifyStatusChanged();
    }

    private void fail(String error) {
        saveStatus("failed", preferences.getInt("progressPercentage", 0), error);
    }

    private void notifyStatusChanged() {
        if (listener != null) listener.onStatusChanged(getStatusJson());
    }

    private long getCurrentVersionCode() {
        try {
            return getVersionCode(activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0));
        } catch (PackageManager.NameNotFoundException error) {
            return 0;
        }
    }

    private String getCurrentVersionName() {
        try {
            String name = activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0).versionName;
            return name == null ? "" : name;
        } catch (PackageManager.NameNotFoundException error) {
            return "";
        }
    }

    private static long getVersionCode(PackageInfo info) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
    }

    private static Set<String> signatureDigests(PackageInfo info) throws Exception {
        Signature[] signatures;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && info.signingInfo != null) {
            signatures = info.signingInfo.hasMultipleSigners()
                ? info.signingInfo.getApkContentsSigners()
                : info.signingInfo.getSigningCertificateHistory();
        } else {
            signatures = info.signatures;
        }
        Set<String> digests = new HashSet<>();
        if (signatures == null) return digests;
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        for (Signature signature : signatures) {
            digests.add(AppUpdateContract.toHex(digest.digest(signature.toByteArray())));
        }
        return digests;
    }

    private static String safeMessage(Exception error) {
        String message = error.getMessage();
        return message == null || message.isEmpty() ? error.getClass().getSimpleName() : message;
    }

    private static final class UpdateManifest {
        final String releaseId;
        final long versionCode;
        final String versionName;
        final String apkUrl;
        final String sha256;

        private UpdateManifest(String releaseId, long versionCode, String versionName, String apkUrl, String sha256) {
            this.releaseId = releaseId;
            this.versionCode = versionCode;
            this.versionName = versionName;
            this.apkUrl = apkUrl;
            this.sha256 = sha256;
        }

        static UpdateManifest parse(String json) throws JSONException {
            JSONObject source = new JSONObject(json == null ? "" : json);
            return new UpdateManifest(
                source.optString("releaseId", "").trim(),
                source.optLong("versionCode", 0),
                source.optString("versionName", "").trim(),
                source.optString("apkUrl", "").trim(),
                source.optString("sha256", "").trim()
            );
        }

        static UpdateManifest fromPreferences(SharedPreferences preferences) {
            return new UpdateManifest(
                preferences.getString("releaseId", ""),
                preferences.getLong("targetVersionCode", 0),
                preferences.getString("targetVersionName", ""),
                preferences.getString("apkUrl", ""),
                preferences.getString("sha256", "")
            );
        }
    }
}
