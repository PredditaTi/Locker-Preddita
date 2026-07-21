import com.preddita.entregaslocker.DiagnosticControlContract;

public final class DiagnosticControlContractTest {
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

    private static void assertInvalidPin(String value) {
        assertions += 1;
        try {
            DiagnosticControlContract.normalizeTechnicalPin(value);
            throw new AssertionError("PIN should have been rejected: " + value);
        } catch (IllegalArgumentException expected) {
            // Expected contract rejection.
        }
    }

    public static void main(String[] args) {
        assertEquals("12345678", DiagnosticControlContract.normalizeTechnicalPin(" 12345678 "), "PIN must be trimmed");
        assertEquals("123456789012", DiagnosticControlContract.normalizeTechnicalPin("123456789012"), "Maximum PIN length must pass");
        assertInvalidPin(null);
        assertInvalidPin("1234567");
        assertInvalidPin("1234567890123");
        assertInvalidPin("1234abcd");

        assertTrue(DiagnosticControlContract.isBrightnessAllowed(10), "Minimum brightness must pass");
        assertTrue(DiagnosticControlContract.isBrightnessAllowed(100), "Maximum brightness must pass");
        assertTrue(!DiagnosticControlContract.isBrightnessAllowed(9), "Brightness below the limit must fail");
        assertTrue(!DiagnosticControlContract.isBrightnessAllowed(101), "Brightness above the limit must fail");

        assertTrue(DiagnosticControlContract.isVolumeAllowed(0), "Muted volume must pass");
        assertTrue(DiagnosticControlContract.isVolumeAllowed(65), "Maximum technical volume must pass");
        assertTrue(!DiagnosticControlContract.isVolumeAllowed(-1), "Negative volume must fail");
        assertTrue(!DiagnosticControlContract.isVolumeAllowed(66), "Volume above the safe limit must fail");

        assertEquals("OK", DiagnosticControlContract.serialErrorCode(true, "anything"), "Open serial must be healthy");
        assertEquals("SERIAL_PERMISSION_DENIED", DiagnosticControlContract.serialErrorCode(false, "permission denied: /dev/ttyS5"), "Permission error must be sanitized");
        assertEquals("SERIAL_PORT_NOT_FOUND", DiagnosticControlContract.serialErrorCode(false, "No such file /secret/path"), "Missing path must be sanitized");
        assertEquals("SERIAL_STARTING", DiagnosticControlContract.serialErrorCode(false, "INIT_PENDING"), "Startup status must be sanitized");
        assertEquals("SERIAL_UNAVAILABLE", DiagnosticControlContract.serialErrorCode(false, "private raw details"), "Unknown errors must be generic");

        System.out.println("DiagnosticControlContractTest passed (" + assertions + " assertions)");
    }
}
