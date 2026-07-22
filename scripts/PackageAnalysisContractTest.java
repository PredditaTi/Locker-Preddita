import com.preddita.entregaslocker.PackageAnalysisContract;

public final class PackageAnalysisContractTest {
    private static int assertions = 0;

    private static void assertTrue(boolean condition, String message) {
        assertions += 1;
        if (!condition) throw new AssertionError(message);
    }

    private static void assertEquals(Object expected, Object actual, String message) {
        assertions += 1;
        if (expected == null ? actual != null : !expected.equals(actual)) {
            throw new AssertionError(message + " expected=" + expected + " actual=" + actual);
        }
    }

    private static void assertRejected(Runnable operation, String message) {
        assertions += 1;
        try {
            operation.run();
            throw new AssertionError(message);
        } catch (IllegalArgumentException expected) {
            // Expected contract rejection.
        }
    }

    public static void main(String[] args) {
        assertEquals("capture-123", PackageAnalysisContract.normalizeRequestId(" capture-123 "), "Request id must be trimmed");
        assertRejected(() -> PackageAnalysisContract.normalizeRequestId(""), "Empty request id must fail");
        assertRejected(() -> PackageAnalysisContract.normalizeRequestId("request with spaces"), "Unsafe request id must fail");
        assertRejected(() -> PackageAnalysisContract.requireSupportedSchema(2), "Unknown schema must fail");

        String jpeg = "data:image/jpeg;base64,AA==";
        assertEquals(jpeg, PackageAnalysisContract.requireJpegDataUrl(jpeg), "JPEG data URL must pass");
        assertRejected(() -> PackageAnalysisContract.requireJpegDataUrl("data:image/png;base64,AA=="), "PNG must fail the capture contract");
        assertEquals(0d, PackageAnalysisContract.normalizeUnitValue(-2d), "Unit value must clamp low");
        assertEquals(1d, PackageAnalysisContract.normalizeUnitValue(2d), "Unit value must clamp high");
        assertEquals("P", PackageAnalysisContract.normalizeSuggestedSize("p"), "P must normalize");
        assertEquals("", PackageAnalysisContract.normalizeSuggestedSize("M"), "M must be rejected");

        assertTrue(
            PackageAnalysisContract.isReadyPrediction(true, "G", 0.94d),
            "Approved model prediction must pass"
        );
        assertTrue(
            !PackageAnalysisContract.isReadyPrediction(false, "G", 0.99d),
            "Unavailable model must never return ready"
        );
        assertTrue(
            !PackageAnalysisContract.isReadyPrediction(true, "P", 0.89d),
            "Low confidence must never return ready"
        );
        assertEquals(
            "analyzer-error",
            PackageAnalysisContract.normalizeReasonCode("private-native-error"),
            "Unknown native errors must be sanitized"
        );

        System.out.println("PackageAnalysisContractTest passed (" + assertions + " assertions)");
    }
}
