import com.preddita.entregaslocker.AppUpdateHealthContract;

public final class AppUpdateHealthContractTest {
    private static void assertEquals(String expected, String actual, String message) {
        if (!expected.equals(actual)) {
            throw new AssertionError(message + ": expected=" + expected + " actual=" + actual);
        }
    }

    private static AppUpdateHealthContract.Signals readySignals() {
        AppUpdateHealthContract.Signals signals = new AppUpdateHealthContract.Signals();
        signals.appStarted = true;
        signals.webViewReady = true;
        signals.edgeAgentReady = true;
        signals.stateLoaded = true;
        signals.configurationBackupChecked = true;
        signals.configurationBackupValid = true;
        signals.credentialAvailable = true;
        signals.serialClassified = true;
        signals.serialHealthy = true;
        return signals;
    }

    public static void main(String[] args) {
        long now = 1_000L;
        assertEquals(
            AppUpdateHealthContract.HEALTHY,
            AppUpdateHealthContract.evaluate(now, 2_000L, 5_000L, readySignals()).status,
            "all required signals should mark the installed version healthy"
        );

        AppUpdateHealthContract.Signals degraded = readySignals();
        degraded.serialHealthy = false;
        degraded.serialErrorCode = "SERIAL_IO_FAILURE";
        AppUpdateHealthContract.Evaluation degradedResult = AppUpdateHealthContract.evaluate(
            now,
            2_000L,
            5_000L,
            degraded
        );
        assertEquals(AppUpdateHealthContract.DEGRADED, degradedResult.status, "serial failure should degrade runtime health");
        assertEquals("SERIAL_IO_FAILURE", degradedResult.errorCode, "serial cause should be preserved");

        AppUpdateHealthContract.Signals invalidBackup = readySignals();
        invalidBackup.configurationBackupValid = false;
        assertEquals(
            AppUpdateHealthContract.FAILED,
            AppUpdateHealthContract.evaluate(now, 2_000L, 5_000L, invalidBackup).status,
            "incompatible configuration should fail closed"
        );

        AppUpdateHealthContract.Signals appDidNotStart = readySignals();
        appDidNotStart.appStarted = false;
        AppUpdateHealthContract.Evaluation startupTimeout = AppUpdateHealthContract.evaluate(
            2_001L,
            2_000L,
            5_000L,
            appDidNotStart
        );
        assertEquals(AppUpdateHealthContract.FAILED, startupTimeout.status, "startup timeout should fail health");
        assertEquals("APP_START_TIMEOUT", startupTimeout.errorCode, "startup timeout should have a stable code");

        AppUpdateHealthContract.Signals serialPending = readySignals();
        serialPending.serialClassified = false;
        assertEquals(
            AppUpdateHealthContract.PENDING,
            AppUpdateHealthContract.evaluate(now, 2_000L, 5_000L, serialPending).status,
            "serial may remain pending inside the health window"
        );
        AppUpdateHealthContract.Evaluation healthTimeout = AppUpdateHealthContract.evaluate(
            5_001L,
            2_000L,
            5_000L,
            serialPending
        );
        assertEquals(AppUpdateHealthContract.FAILED, healthTimeout.status, "health window expiry should fail health");
        assertEquals("SERIAL_HEALTH_TIMEOUT", healthTimeout.errorCode, "serial timeout should be explicit");

        System.out.println("PASS native app update health contract");
    }
}
