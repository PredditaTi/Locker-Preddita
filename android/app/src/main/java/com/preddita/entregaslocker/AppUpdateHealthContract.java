package com.preddita.entregaslocker;

public final class AppUpdateHealthContract {
    public static final String PENDING = "installed-pending-health";
    public static final String HEALTHY = "healthy";
    public static final String DEGRADED = "degraded";
    public static final String FAILED = "failed-health";

    private AppUpdateHealthContract() {
    }

    public static Evaluation evaluate(
        long nowMs,
        long startupDeadlineMs,
        long healthDeadlineMs,
        Signals signals
    ) {
        Signals safe = signals == null ? new Signals() : signals;
        if (!safe.fatalErrorCode.isEmpty()) {
            return failed(safe.fatalErrorCode);
        }
        if (safe.configurationBackupChecked && !safe.configurationBackupValid) {
            return failed("CONFIGURATION_BACKUP_INVALID");
        }

        boolean runtimeReady = safe.appStarted
            && safe.webViewReady
            && safe.edgeAgentReady
            && safe.stateLoaded
            && safe.configurationBackupChecked
            && safe.configurationBackupValid
            && safe.credentialAvailable;
        if (runtimeReady && safe.serialClassified) {
            return safe.serialHealthy
                ? new Evaluation(HEALTHY, "", "Versao pronta para operacao.")
                : new Evaluation(
                    DEGRADED,
                    safe.serialErrorCode.isEmpty() ? "SERIAL_DEGRADED" : safe.serialErrorCode,
                    "Verifique a UART, o chicote e a alimentacao da controladora."
                );
        }

        if (startupDeadlineMs > 0 && nowMs >= startupDeadlineMs) {
            if (!safe.appStarted) return failed("APP_START_TIMEOUT");
            if (!safe.webViewReady) return failed("WEBVIEW_START_TIMEOUT");
            if (!safe.edgeAgentReady) return failed("EDGE_AGENT_START_TIMEOUT");
            if (!safe.stateLoaded) return failed("STATE_LOAD_FAILED");
            if (!safe.configurationBackupChecked) return failed("CONFIGURATION_BACKUP_NOT_CHECKED");
            if (!safe.credentialAvailable) return failed("DEVICE_CREDENTIAL_UNAVAILABLE");
        }

        if (healthDeadlineMs > 0 && nowMs >= healthDeadlineMs) {
            if (!safe.serialClassified) return failed("SERIAL_HEALTH_TIMEOUT");
            return failed("HEALTH_CHECK_TIMEOUT");
        }

        return new Evaluation(PENDING, "", "Aguardando os sinais de inicializacao do aplicativo.");
    }

    public static String recommendedAction(String errorCode) {
        String code = errorCode == null ? "" : errorCode;
        if (code.startsWith("SERIAL_")) {
            return "Verifique a UART, o chicote e a alimentacao da controladora.";
        }
        if (code.startsWith("CONFIGURATION_") || "STATE_LOAD_FAILED".equals(code)) {
            return "Preserve os dados atuais e restaure a configuracao validada por ADB ou MDM.";
        }
        if (code.contains("CREDENTIAL")) {
            return "Reprovisione a credencial HMAC pelo fluxo local autenticado.";
        }
        return "Pause o rollout e publique uma versao superior assinada ou recupere por ADB ou MDM.";
    }

    private static Evaluation failed(String code) {
        return new Evaluation(FAILED, code, recommendedAction(code));
    }

    public static final class Signals {
        public boolean appStarted;
        public boolean webViewReady;
        public boolean edgeAgentReady;
        public boolean stateLoaded;
        public boolean configurationBackupChecked;
        public boolean configurationBackupValid;
        public boolean credentialAvailable;
        public boolean serialClassified;
        public boolean serialHealthy;
        public String serialErrorCode = "";
        public String fatalErrorCode = "";
    }

    public static final class Evaluation {
        public final String status;
        public final String errorCode;
        public final String recommendedAction;

        Evaluation(String status, String errorCode, String recommendedAction) {
            this.status = status;
            this.errorCode = errorCode;
            this.recommendedAction = recommendedAction;
        }
    }
}
