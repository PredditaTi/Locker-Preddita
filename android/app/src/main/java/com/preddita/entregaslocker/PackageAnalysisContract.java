package com.preddita.entregaslocker;

public final class PackageAnalysisContract {
    public static final int SCHEMA_VERSION = 1;
    public static final int MAX_REQUEST_ID_LENGTH = 80;
    public static final int MAX_IMAGE_DATA_URL_CHARS = 900_000;
    public static final double MIN_CAPTURE_QUALITY = 0.60d;
    public static final double MIN_READY_CONFIDENCE = 0.90d;
    public static final String STATUS_READY = "ready";
    public static final String STATUS_UNCERTAIN = "uncertain";
    public static final String STATUS_FAILED = "failed";

    private PackageAnalysisContract() {
    }

    public static String normalizeRequestId(String rawValue) {
        String value = rawValue == null ? "" : rawValue.trim();
        if (
            value.isEmpty()
                || value.length() > MAX_REQUEST_ID_LENGTH
                || !value.matches("[A-Za-z0-9._:-]+")
        ) {
            throw new IllegalArgumentException("INVALID_REQUEST_ID");
        }
        return value;
    }

    public static void requireSupportedSchema(int schemaVersion) {
        if (schemaVersion != SCHEMA_VERSION) {
            throw new IllegalArgumentException("UNSUPPORTED_SCHEMA");
        }
    }

    public static String requireJpegDataUrl(String rawValue) {
        String value = rawValue == null ? "" : rawValue.trim();
        if (
            !value.startsWith("data:image/jpeg;base64,")
                || value.length() > MAX_IMAGE_DATA_URL_CHARS
        ) {
            throw new IllegalArgumentException("INVALID_IMAGE");
        }
        return value;
    }

    public static double normalizeUnitValue(double value) {
        if (!Double.isFinite(value)) return 0d;
        return Math.max(0d, Math.min(1d, value));
    }

    public static String normalizeSuggestedSize(String rawValue) {
        String value = rawValue == null ? "" : rawValue.trim().toUpperCase(java.util.Locale.ROOT);
        return "P".equals(value) || "G".equals(value) ? value : "";
    }

    public static boolean isReadyPrediction(
        boolean modelAvailable,
        String suggestedSize,
        double confidence
    ) {
        return modelAvailable
            && !normalizeSuggestedSize(suggestedSize).isEmpty()
            && Double.isFinite(confidence)
            && confidence >= MIN_READY_CONFIDENCE
            && confidence <= 1d;
    }

    public static String normalizeReasonCode(String rawValue) {
        String value = rawValue == null ? "" : rawValue.trim().toLowerCase();
        switch (value) {
            case "model-not-installed":
            case "model-checksum-mismatch":
            case "model-runtime-not-installed":
            case "low-capture-quality":
            case "invalid-request":
            case "invalid-image":
            case "unsupported-schema":
            case "analyzer-busy":
            case "analyzer-error":
                return value;
            default:
                return "analyzer-error";
        }
    }
}
