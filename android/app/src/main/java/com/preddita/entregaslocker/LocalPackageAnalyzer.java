package com.preddita.entregaslocker;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;

import org.json.JSONObject;

import java.io.InputStream;
import java.security.MessageDigest;
import java.util.Locale;

public final class LocalPackageAnalyzer {
    public static final String BRIDGE_VERSION = "PREDDITA-PACKAGE-ANALYZER-1.0.0";
    public static final String EXPECTED_MODEL_VERSION = "package-pg-v1";
    public static final String MODEL_ASSET_PATH = "models/package-size-pg-v1.tflite";
    private static final int MAX_IMAGE_DIMENSION = 4096;
    private static final long MAX_IMAGE_PIXELS = 8_000_000L;

    // Filled only after the calibrated model from Part 5 is approved.
    private static final String EXPECTED_MODEL_SHA256 = "";

    private final Context context;
    private final ModelInfo modelInfo;

    public LocalPackageAnalyzer(Context context) {
        this.context = context.getApplicationContext();
        this.modelInfo = inspectModel();
    }

    public String getInfoJson() {
        try {
            return new JSONObject()
                .put("schemaVersion", PackageAnalysisContract.SCHEMA_VERSION)
                .put("bridgeVersion", BRIDGE_VERSION)
                .put("modelVersion", EXPECTED_MODEL_VERSION)
                .put("modelAvailable", modelInfo.available)
                .put("modelSha256", modelInfo.available ? modelInfo.sha256 : "")
                .put("reasonCode", modelInfo.reasonCode)
                .toString();
        } catch (Exception error) {
            return "{\"schemaVersion\":1,\"modelAvailable\":false,\"reasonCode\":\"analyzer-error\"}";
        }
    }

    public String analyze(String requestJson) {
        long startedAt = System.nanoTime();
        String requestId = "invalid-request";
        double captureQuality = 0d;

        try {
            JSONObject request = new JSONObject(requestJson == null ? "{}" : requestJson);
            requestId = PackageAnalysisContract.normalizeRequestId(request.optString("requestId", ""));
            PackageAnalysisContract.requireSupportedSchema(request.optInt("schemaVersion", 0));
            captureQuality = PackageAnalysisContract.normalizeUnitValue(
                request.optDouble("captureQuality", 0d)
            );
            String photoDataUrl = PackageAnalysisContract.requireJpegDataUrl(
                request.optString("photoDataUrl", "")
            );
            Bitmap bitmap = decodeJpeg(photoDataUrl);
            if (bitmap == null || bitmap.getWidth() < 64 || bitmap.getHeight() < 64) {
                return buildResult(
                    requestId,
                    PackageAnalysisContract.STATUS_FAILED,
                    "",
                    null,
                    captureQuality,
                    "invalid-image",
                    elapsedMs(startedAt),
                    0,
                    0
                );
            }

            int imageWidth = bitmap.getWidth();
            int imageHeight = bitmap.getHeight();
            bitmap.recycle();

            if (captureQuality < PackageAnalysisContract.MIN_CAPTURE_QUALITY) {
                return buildResult(
                    requestId,
                    PackageAnalysisContract.STATUS_UNCERTAIN,
                    "",
                    null,
                    captureQuality,
                    "low-capture-quality",
                    elapsedMs(startedAt),
                    imageWidth,
                    imageHeight
                );
            }

            if (!modelInfo.available) {
                return buildResult(
                    requestId,
                    PackageAnalysisContract.STATUS_UNCERTAIN,
                    "",
                    null,
                    captureQuality,
                    modelInfo.reasonCode,
                    elapsedMs(startedAt),
                    imageWidth,
                    imageHeight
                );
            }

            return buildResult(
                requestId,
                PackageAnalysisContract.STATUS_UNCERTAIN,
                "",
                null,
                captureQuality,
                "model-runtime-not-installed",
                elapsedMs(startedAt),
                imageWidth,
                imageHeight
            );
        } catch (IllegalArgumentException error) {
            String reasonCode = "UNSUPPORTED_SCHEMA".equals(error.getMessage())
                ? "unsupported-schema"
                : "INVALID_IMAGE".equals(error.getMessage())
                ? "invalid-image"
                : "invalid-request";
            return buildResult(
                requestId,
                PackageAnalysisContract.STATUS_FAILED,
                "",
                null,
                captureQuality,
                reasonCode,
                elapsedMs(startedAt),
                0,
                0
            );
        } catch (Exception error) {
            return buildResult(
                requestId,
                PackageAnalysisContract.STATUS_FAILED,
                "",
                null,
                captureQuality,
                "analyzer-error",
                elapsedMs(startedAt),
                0,
                0
            );
        }
    }

    private Bitmap decodeJpeg(String photoDataUrl) {
        int separator = photoDataUrl.indexOf(',');
        if (separator < 0 || separator >= photoDataUrl.length() - 1) return null;
        try {
            byte[] bytes = Base64.decode(photoDataUrl.substring(separator + 1), Base64.DEFAULT);
            if (
                bytes.length < 4
                    || (bytes[0] & 0xff) != 0xff
                    || (bytes[1] & 0xff) != 0xd8
                    || (bytes[bytes.length - 2] & 0xff) != 0xff
                    || (bytes[bytes.length - 1] & 0xff) != 0xd9
            ) {
                return null;
            }
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
            long pixels = (long) bounds.outWidth * (long) bounds.outHeight;
            if (
                bounds.outWidth < 64
                    || bounds.outHeight < 64
                    || bounds.outWidth > MAX_IMAGE_DIMENSION
                    || bounds.outHeight > MAX_IMAGE_DIMENSION
                    || pixels > MAX_IMAGE_PIXELS
            ) {
                return null;
            }
            return BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException("INVALID_IMAGE");
        }
    }

    private String buildResult(
        String requestId,
        String status,
        String suggestedSize,
        Double confidence,
        double captureQuality,
        String reasonCode,
        long inferenceMs,
        int imageWidth,
        int imageHeight
    ) {
        try {
            JSONObject result = new JSONObject()
                .put("schemaVersion", PackageAnalysisContract.SCHEMA_VERSION)
                .put("requestId", requestId)
                .put("status", status)
                .put("suggestedSize", PackageAnalysisContract.normalizeSuggestedSize(suggestedSize))
                .put("confidence", confidence == null ? JSONObject.NULL : confidence)
                .put("captureQuality", PackageAnalysisContract.normalizeUnitValue(captureQuality))
                .put("modelVersion", EXPECTED_MODEL_VERSION)
                .put("modelSha256", modelInfo.available ? modelInfo.sha256 : "")
                .put("inferenceMs", Math.max(0L, inferenceMs))
                .put("reasonCode", PackageAnalysisContract.normalizeReasonCode(reasonCode))
                .put("imageWidth", Math.max(0, imageWidth))
                .put("imageHeight", Math.max(0, imageHeight));
            return result.toString();
        } catch (Exception error) {
            return "{\"schemaVersion\":1,\"requestId\":\"invalid-request\",\"status\":\"failed\",\"reasonCode\":\"analyzer-error\"}";
        }
    }

    private ModelInfo inspectModel() {
        try (InputStream input = context.getAssets().open(MODEL_ASSET_PATH)) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                if (read > 0) digest.update(buffer, 0, read);
            }
            String sha256 = toHex(digest.digest());
            if (EXPECTED_MODEL_SHA256.isEmpty()) {
                return new ModelInfo(false, "", "model-checksum-mismatch");
            }
            boolean matches = EXPECTED_MODEL_SHA256.equalsIgnoreCase(sha256);
            return new ModelInfo(
                matches,
                matches ? sha256 : "",
                matches ? "" : "model-checksum-mismatch"
            );
        } catch (Exception error) {
            return new ModelInfo(false, "", "model-not-installed");
        }
    }

    private String toHex(byte[] digest) {
        StringBuilder value = new StringBuilder(digest.length * 2);
        for (byte part : digest) value.append(String.format(Locale.ROOT, "%02x", part & 0xff));
        return value.toString();
    }

    private long elapsedMs(long startedAt) {
        return Math.max(0L, (System.nanoTime() - startedAt) / 1_000_000L);
    }

    private static final class ModelInfo {
        final boolean available;
        final String sha256;
        final String reasonCode;

        ModelInfo(boolean available, String sha256, String reasonCode) {
            this.available = available;
            this.sha256 = sha256;
            this.reasonCode = reasonCode;
        }
    }
}
