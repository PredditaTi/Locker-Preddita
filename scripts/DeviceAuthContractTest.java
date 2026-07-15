import com.preddita.entregaslocker.DeviceAuthContract;

public final class DeviceAuthContractTest {
    public static void main(String[] args) {
        String contentHash = "f".repeat(64);
        String canonical = DeviceAuthContract.buildCanonical(
            "post",
            "/api/device/status",
            "ks1062-aurora",
            "1784150000000",
            "nonce-device-auth-0001",
            contentHash.toUpperCase()
        );
        String expected = String.join(
            "\n",
            "PREDDITA-HMAC-V1",
            "POST",
            "/api/device/status",
            "ks1062-aurora",
            "1784150000000",
            "nonce-device-auth-0001",
            contentHash
        );
        assertEquals(expected, canonical, "canonical HMAC contract");
        assertThrows(() -> DeviceAuthContract.normalizeMethod("DELETE"), "invalid method");
        assertThrows(() -> DeviceAuthContract.normalizePath("/api/admin/state"), "admin path");
        assertThrows(() -> DeviceAuthContract.normalizePath("https://evil.test/api/device/status"), "absolute URL");
        assertThrows(() -> DeviceAuthContract.normalizeLockerId("x"), "short locker id");
        assertThrows(() -> DeviceAuthContract.normalizeNonce("short"), "short nonce");
        assertThrows(() -> DeviceAuthContract.normalizeSha256("not-a-hash"), "invalid hash");
        assertEquals("00ff10", DeviceAuthContract.bytesToHex(new byte[]{0x00, (byte) 0xff, 0x10}), "hex");
        System.out.println("PREDDITA_DEVICE_AUTH_CONTRACT_OK");
    }

    private static void assertEquals(String expected, String actual, String label) {
        if (!expected.equals(actual)) {
            throw new AssertionError(label + ": expected=" + expected + " actual=" + actual);
        }
    }

    private static void assertThrows(Runnable runnable, String label) {
        try {
            runnable.run();
            throw new AssertionError(label + ": expected exception");
        } catch (IllegalArgumentException expected) {
        }
    }
}
