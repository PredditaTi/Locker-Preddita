package com.preddita.entregaslocker;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

public final class AppUpdateContract {
    private AppUpdateContract() {
    }

    public static boolean isUpgrade(long currentVersionCode, long targetVersionCode) {
        return targetVersionCode > currentVersionCode;
    }

    public static boolean isValidSha256(String value) {
        return value != null && value.matches("(?i)^[a-f0-9]{64}$");
    }

    public static boolean isValidHttpsUrl(String value) {
        try {
            URI uri = URI.create(value == null ? "" : value.trim());
            return "https".equalsIgnoreCase(uri.getScheme())
                && uri.getHost() != null
                && !uri.getHost().isEmpty()
                && uri.getUserInfo() == null;
        } catch (IllegalArgumentException error) {
            return false;
        }
    }

    public static String sha256(File file) throws IOException {
        try (InputStream input = new FileInputStream(file)) {
            return sha256(input);
        }
    }

    public static String sha256(InputStream input) throws IOException {
        final MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 indisponivel", error);
        }

        byte[] buffer = new byte[8192];
        int read;
        while ((read = input.read(buffer)) >= 0) {
            if (read > 0) digest.update(buffer, 0, read);
        }
        return toHex(digest.digest());
    }

    public static boolean matchesSha256(String expected, String actual) {
        if (!isValidSha256(expected) || !isValidSha256(actual)) return false;
        return MessageDigest.isEqual(
            expected.toLowerCase().getBytes(java.nio.charset.StandardCharsets.US_ASCII),
            actual.toLowerCase().getBytes(java.nio.charset.StandardCharsets.US_ASCII)
        );
    }

    public static String toHex(byte[] value) {
        StringBuilder result = new StringBuilder(value.length * 2);
        for (byte item : value) result.append(String.format("%02x", item & 0xff));
        return result.toString();
    }
}
