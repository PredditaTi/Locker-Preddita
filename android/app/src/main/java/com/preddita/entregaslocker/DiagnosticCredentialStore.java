package com.preddita.entregaslocker;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;

import org.json.JSONObject;

import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;

import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;

public final class DiagnosticCredentialStore {
    private static final String PREFERENCES = "preddita_diagnostic_credential_v1";
    private static final String PREF_SALT = "salt";
    private static final String PREF_HASH = "hash";
    private static final String PREF_PROVISIONED_AT = "provisioned_at";
    private static final int PBKDF2_ITERATIONS = 120_000;
    private static final int HASH_BITS = 256;

    private final SharedPreferences preferences;

    public DiagnosticCredentialStore(Context context) {
        preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    public synchronized void provision(String rawPin) throws Exception {
        String pin = DiagnosticControlContract.normalizeTechnicalPin(rawPin);
        byte[] salt = new byte[16];
        new SecureRandom().nextBytes(salt);
        byte[] hash = derive(pin, salt);
        boolean saved = preferences.edit()
            .putString(PREF_SALT, Base64.encodeToString(salt, Base64.NO_WRAP))
            .putString(PREF_HASH, Base64.encodeToString(hash, Base64.NO_WRAP))
            .putLong(PREF_PROVISIONED_AT, System.currentTimeMillis())
            .commit();
        Arrays.fill(hash, (byte) 0);
        if (!saved) throw new IllegalStateException("Nao foi possivel salvar a credencial tecnica.");
    }

    public synchronized boolean verify(String rawPin) {
        if (!isProvisioned()) return false;
        byte[] actual = null;
        byte[] expected = null;
        try {
            String pin = DiagnosticControlContract.normalizeTechnicalPin(rawPin);
            byte[] salt = Base64.decode(preferences.getString(PREF_SALT, ""), Base64.NO_WRAP);
            expected = Base64.decode(preferences.getString(PREF_HASH, ""), Base64.NO_WRAP);
            actual = derive(pin, salt);
            return MessageDigest.isEqual(expected, actual);
        } catch (Exception ignored) {
            return false;
        } finally {
            if (actual != null) Arrays.fill(actual, (byte) 0);
            if (expected != null) Arrays.fill(expected, (byte) 0);
        }
    }

    public boolean isProvisioned() {
        return !preferences.getString(PREF_SALT, "").isEmpty()
            && !preferences.getString(PREF_HASH, "").isEmpty();
    }

    public String getStatusJson(long lockedUntilMs) {
        JSONObject payload = new JSONObject();
        try {
            payload.put("available", true);
            payload.put("provisioned", isProvisioned());
            payload.put("minimumLength", DiagnosticControlContract.MIN_PIN_LENGTH);
            payload.put("provisionedAt", preferences.getLong(PREF_PROVISIONED_AT, 0L));
            payload.put("lockedUntil", Math.max(0L, lockedUntilMs));
        } catch (Exception ignored) {
        }
        return payload.toString();
    }

    private byte[] derive(String pin, byte[] salt) throws Exception {
        PBEKeySpec specification = new PBEKeySpec(
            pin.toCharArray(),
            salt,
            PBKDF2_ITERATIONS,
            HASH_BITS
        );
        try {
            return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
                .generateSecret(specification)
                .getEncoded();
        } finally {
            specification.clearPassword();
        }
    }
}
