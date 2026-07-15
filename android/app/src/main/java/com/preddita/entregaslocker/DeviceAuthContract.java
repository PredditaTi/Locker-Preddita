package com.preddita.entregaslocker;

import java.util.Locale;

public final class DeviceAuthContract {
    public static final String SCHEME = "PREDDITA-HMAC-V1";

    private DeviceAuthContract() {
    }

    public static String buildCanonical(
        String method,
        String path,
        String lockerId,
        String timestamp,
        String nonce,
        String contentSha256
    ) {
        return String.join(
            "\n",
            SCHEME,
            normalizeMethod(method),
            normalizePath(path),
            normalizeLockerId(lockerId),
            normalizeTimestamp(timestamp),
            normalizeNonce(nonce),
            normalizeSha256(contentSha256)
        );
    }

    public static String normalizeMethod(String value) {
        String method = clean(value).toUpperCase(Locale.ROOT);
        if (!"GET".equals(method) && !"POST".equals(method)) {
            throw new IllegalArgumentException("DEVICE_AUTH_INVALID_METHOD");
        }
        return method;
    }

    public static String normalizePath(String value) {
        String path = clean(value);
        if (
            !(path.equals("/api/device") || path.startsWith("/api/device/")) ||
            path.contains("://") ||
            path.contains("#") ||
            path.contains("\r") ||
            path.contains("\n") ||
            path.matches(".*\\s+.*")
        ) {
            throw new IllegalArgumentException("DEVICE_AUTH_INVALID_PATH");
        }
        return path;
    }

    public static String normalizeLockerId(String value) {
        String lockerId = clean(value);
        if (!lockerId.matches("[A-Za-z0-9][A-Za-z0-9._-]{2,63}")) {
            throw new IllegalArgumentException("DEVICE_AUTH_INVALID_LOCKER_ID");
        }
        return lockerId;
    }

    public static String normalizeTimestamp(String value) {
        String timestamp = clean(value);
        if (!timestamp.matches("\\d{10,16}")) {
            throw new IllegalArgumentException("DEVICE_AUTH_INVALID_TIMESTAMP");
        }
        try {
            Long.parseLong(timestamp);
        } catch (NumberFormatException error) {
            throw new IllegalArgumentException("DEVICE_AUTH_INVALID_TIMESTAMP", error);
        }
        return timestamp;
    }

    public static String normalizeNonce(String value) {
        String nonce = clean(value);
        if (!nonce.matches("[A-Za-z0-9._:-]{16,128}")) {
            throw new IllegalArgumentException("DEVICE_AUTH_INVALID_NONCE");
        }
        return nonce;
    }

    public static String normalizeSha256(String value) {
        String digest = clean(value).toLowerCase(Locale.ROOT);
        if (!digest.matches("[a-f0-9]{64}")) {
            throw new IllegalArgumentException("DEVICE_AUTH_INVALID_CONTENT_HASH");
        }
        return digest;
    }

    public static String bytesToHex(byte[] bytes) {
        StringBuilder builder = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) {
            builder.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        }
        return builder.toString();
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}
