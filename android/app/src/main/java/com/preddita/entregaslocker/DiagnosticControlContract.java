package com.preddita.entregaslocker;

public final class DiagnosticControlContract {
    public static final int MIN_PIN_LENGTH = 8;
    public static final int MAX_PIN_LENGTH = 12;
    public static final int MIN_BRIGHTNESS_PERCENT = 10;
    public static final int MAX_BRIGHTNESS_PERCENT = 100;
    public static final int MIN_VOLUME_PERCENT = 0;
    public static final int MAX_VOLUME_PERCENT = 65;

    private DiagnosticControlContract() {
    }

    public static String normalizeTechnicalPin(String rawValue) {
        String value = rawValue == null ? "" : rawValue.trim();
        if (
            value.length() < MIN_PIN_LENGTH
                || value.length() > MAX_PIN_LENGTH
                || !value.matches("[0-9]+")
        ) {
            throw new IllegalArgumentException(
                "O PIN tecnico deve ter entre " + MIN_PIN_LENGTH + " e " + MAX_PIN_LENGTH + " digitos."
            );
        }
        return value;
    }

    public static boolean isBrightnessAllowed(int percent) {
        return percent >= MIN_BRIGHTNESS_PERCENT && percent <= MAX_BRIGHTNESS_PERCENT;
    }

    public static boolean isVolumeAllowed(int percent) {
        return percent >= MIN_VOLUME_PERCENT && percent <= MAX_VOLUME_PERCENT;
    }

    public static String serialErrorCode(boolean serialOpen, String rawError) {
        if (serialOpen) return "OK";
        String normalized = rawError == null ? "" : rawError.trim().toUpperCase();
        if (normalized.contains("PERMISSION")) return "SERIAL_PERMISSION_DENIED";
        if (normalized.contains("NO_SERIAL_PORT") || normalized.contains("NO SUCH FILE")) {
            return "SERIAL_PORT_NOT_FOUND";
        }
        if (normalized.contains("INIT_PENDING")) return "SERIAL_STARTING";
        return "SERIAL_UNAVAILABLE";
    }
}
