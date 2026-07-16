import com.preddita.entregaslocker.AppUpdateContract;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;

public final class AppUpdateContractTest {
    private static void assertTrue(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    private static void assertFalse(boolean value, String message) {
        assertTrue(!value, message);
    }

    public static void main(String[] args) throws Exception {
        assertTrue(AppUpdateContract.isUpgrade(21, 22), "newer versionCode should be accepted");
        assertFalse(AppUpdateContract.isUpgrade(22, 22), "same versionCode should be rejected");
        assertFalse(AppUpdateContract.isUpgrade(23, 22), "downgrade should be rejected");

        assertTrue(AppUpdateContract.isValidHttpsUrl("https://github.com/preddita/app.apk"), "HTTPS URL should be valid");
        assertFalse(AppUpdateContract.isValidHttpsUrl("http://github.com/preddita/app.apk"), "HTTP URL should be rejected");
        assertFalse(AppUpdateContract.isValidHttpsUrl("https://user:secret@example.com/app.apk"), "embedded credentials should be rejected");

        String digest = AppUpdateContract.sha256(new ByteArrayInputStream("abc".getBytes(StandardCharsets.US_ASCII)));
        String expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assertTrue(AppUpdateContract.matchesSha256(expected, digest), "SHA-256 must match known vector");
        assertFalse(AppUpdateContract.matchesSha256("0".repeat(64), digest), "different SHA-256 must fail");
        assertFalse(AppUpdateContract.isValidSha256("not-a-digest"), "malformed SHA-256 should be rejected");

        System.out.println("PASS native app update contract");
    }
}
