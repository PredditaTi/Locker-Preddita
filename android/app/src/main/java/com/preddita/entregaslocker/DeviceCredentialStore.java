package com.preddita.entregaslocker;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyProperties;
import android.security.keystore.KeyProtection;

import org.json.JSONObject;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Locale;

import javax.crypto.Mac;
import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;

public final class DeviceCredentialStore {
    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "preddita_device_hmac_v1";
    private static final String PREFS_NAME = "preddita_secure_device_v1";
    private static final String PREF_BASE_URL = "base_url";
    private static final String PREF_LOCKER_ID = "locker_id";
    private static final String PREF_PROVISIONED_AT = "provisioned_at";
    private static final long MAX_LOCAL_TIMESTAMP_SKEW_MS = 5 * 60 * 1000L;

    private final SharedPreferences preferences;
    private boolean provisioned;
    private SecretKey signingKey;

    public DeviceCredentialStore(Context context) {
        preferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        provisioned = hasStoredKeyAndConfig();
    }

    public synchronized void provision(
        String rawBaseUrl,
        String rawLockerId,
        String rawDeviceKey,
        boolean allowDebugHttp
    ) throws Exception {
        String baseUrl = normalizeBaseUrl(rawBaseUrl, allowDebugHttp);
        String lockerId = DeviceAuthContract.normalizeLockerId(rawLockerId);
        String deviceKey = rawDeviceKey == null ? "" : rawDeviceKey.trim();
        if (deviceKey.getBytes(StandardCharsets.UTF_8).length < 32) {
            throw new IllegalArgumentException("A chave deve ter pelo menos 32 bytes.");
        }

        KeyStore keyStore = loadKeyStore();
        SecretKey importedKey = new SecretKeySpec(
            deviceKey.getBytes(StandardCharsets.UTF_8),
            KeyProperties.KEY_ALGORITHM_HMAC_SHA256
        );
        KeyProtection protection = new KeyProtection.Builder(
            KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY
        )
            .setDigests(KeyProperties.DIGEST_SHA256)
            .build();
        keyStore.setEntry(KEY_ALIAS, new KeyStore.SecretKeyEntry(importedKey), protection);

        boolean saved = preferences.edit()
            .putString(PREF_BASE_URL, baseUrl)
            .putString(PREF_LOCKER_ID, lockerId)
            .putLong(PREF_PROVISIONED_AT, System.currentTimeMillis())
            .commit();
        if (!saved) {
            keyStore.deleteEntry(KEY_ALIAS);
            provisioned = false;
            throw new IllegalStateException("Nao foi possivel salvar a configuracao segura.");
        }
        signingKey = null;
        provisioned = true;
    }

    public synchronized String signRequest(
        String method,
        String path,
        String timestamp,
        String nonce,
        String contentSha256
    ) throws Exception {
        String lockerId = getLockerId();
        if (!isProvisioned()) {
            throw new IllegalStateException("DEVICE_NOT_PROVISIONED");
        }

        String canonical = DeviceAuthContract.buildCanonical(
            method,
            path,
            lockerId,
            timestamp,
            nonce,
            contentSha256
        );
        long timestampMs = Long.parseLong(DeviceAuthContract.normalizeTimestamp(timestamp));
        long now = System.currentTimeMillis();
        if (
            timestampMs < now - MAX_LOCAL_TIMESTAMP_SKEW_MS ||
            timestampMs > now + MAX_LOCAL_TIMESTAMP_SKEW_MS
        ) {
            throw new IllegalArgumentException("DEVICE_AUTH_TIMESTAMP_OUT_OF_RANGE");
        }

        Mac mac = Mac.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256);
        mac.init(getSigningKey());
        return "v1=" + DeviceAuthContract.bytesToHex(
            mac.doFinal(canonical.getBytes(StandardCharsets.UTF_8))
        );
    }

    public synchronized boolean isProvisioned() {
        return provisioned;
    }

    private boolean hasStoredKeyAndConfig() {
        if (getBaseUrl().isEmpty() || getLockerId().isEmpty()) {
            return false;
        }
        try {
            return loadKeyStore().containsAlias(KEY_ALIAS);
        } catch (Exception error) {
            return false;
        }
    }

    private synchronized SecretKey getSigningKey() throws Exception {
        if (signingKey != null) {
            return signingKey;
        }
        KeyStore.Entry entry = loadKeyStore().getEntry(KEY_ALIAS, null);
        if (!(entry instanceof KeyStore.SecretKeyEntry)) {
            provisioned = false;
            throw new IllegalStateException("DEVICE_KEY_NOT_AVAILABLE");
        }
        signingKey = ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        return signingKey;
    }

    public String getBaseUrl() {
        return preferences.getString(PREF_BASE_URL, "");
    }

    public String getLockerId() {
        return preferences.getString(PREF_LOCKER_ID, "");
    }

    public String getConfigJson() {
        JSONObject payload = new JSONObject();
        try {
            payload.put("available", true);
            payload.put("provisioned", isProvisioned());
            payload.put("baseUrl", getBaseUrl());
            payload.put("lockerId", getLockerId());
            payload.put("provisionedAt", preferences.getLong(PREF_PROVISIONED_AT, 0L));
            payload.put("signer", "android-keystore");
        } catch (Exception ignored) {
        }
        return payload.toString();
    }

    private KeyStore loadKeyStore() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
        keyStore.load(null);
        return keyStore;
    }

    private String normalizeBaseUrl(String rawValue, boolean allowDebugHttp) throws Exception {
        String value = rawValue == null ? "" : rawValue.trim();
        while (value.endsWith("/")) {
            value = value.substring(0, value.length() - 1);
        }
        URI uri = new URI(value);
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
        boolean debugLoopback = allowDebugHttp
            && "http".equals(scheme)
            && ("127.0.0.1".equals(host) || "localhost".equals(host) || "::1".equals(host));
        boolean cleanPath = uri.getPath() == null || uri.getPath().isEmpty() || "/".equals(uri.getPath());

        if (
            host.isEmpty() ||
            !("https".equals(scheme) || debugLoopback) ||
            uri.getUserInfo() != null ||
            uri.getQuery() != null ||
            uri.getFragment() != null ||
            !cleanPath
        ) {
            throw new IllegalArgumentException("Use uma URL HTTPS sem caminho, query ou credenciais.");
        }
        return value;
    }
}
