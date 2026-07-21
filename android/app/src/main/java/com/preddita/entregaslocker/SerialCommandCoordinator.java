package com.preddita.entregaslocker;

import java.util.Arrays;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Owns the RS-485 command lifecycle for one physical bus.
 *
 * The worker is the only code allowed to call Transport.write. Reads may be
 * retried once; commands that can move a lock are never repeated after a write
 * may have reached the board.
 */
public final class SerialCommandCoordinator {
    private static final int READ_MAX_ATTEMPTS = 2;
    private static final int OTHER_MAX_ATTEMPTS = 1;

    public enum OperationKind {
        READ,
        ACTUATION,
        CONFIGURATION
    }

    public interface Transport {
        boolean isAvailable();

        void write(byte[] frame) throws Exception;

        boolean recover();
    }

    public interface Listener {
        void onResult(Result result);
    }

    public static final class Result {
        private final String executionId;
        private final OperationKind operationKind;
        private final boolean ok;
        private final String errorCode;
        private final byte[] response;
        private final int attempts;
        private final long queueWaitMs;
        private final long durationMs;
        private final boolean executionOutcomeUnknown;

        private Result(
            String executionId,
            OperationKind operationKind,
            boolean ok,
            String errorCode,
            byte[] response,
            int attempts,
            long queueWaitMs,
            long durationMs,
            boolean executionOutcomeUnknown
        ) {
            this.executionId = executionId;
            this.operationKind = operationKind;
            this.ok = ok;
            this.errorCode = errorCode;
            this.response = response == null ? null : Arrays.copyOf(response, response.length);
            this.attempts = attempts;
            this.queueWaitMs = queueWaitMs;
            this.durationMs = durationMs;
            this.executionOutcomeUnknown = executionOutcomeUnknown;
        }

        public String getExecutionId() {
            return executionId;
        }

        public OperationKind getOperationKind() {
            return operationKind;
        }

        public boolean isOk() {
            return ok;
        }

        public String getErrorCode() {
            return errorCode;
        }

        public byte[] getResponse() {
            return response == null ? null : Arrays.copyOf(response, response.length);
        }

        public int getAttempts() {
            return attempts;
        }

        public long getQueueWaitMs() {
            return queueWaitMs;
        }

        public long getDurationMs() {
            return durationMs;
        }

        public boolean isExecutionOutcomeUnknown() {
            return executionOutcomeUnknown;
        }
    }

    public static final class Metrics {
        public final String state;
        public final int queueDepth;
        public final int maxQueueDepth;
        public final boolean inFlight;
        public final int blockedActuations;
        public final long submitted;
        public final long completed;
        public final long rejected;
        public final long writes;
        public final long readRetries;
        public final long timeouts;
        public final long invalidFrames;
        public final long discardedBytes;
        public final long mismatchedFrames;
        public final long echoes;
        public final long ioFailures;
        public final long reconnections;
        public final long unknownActuations;
        public final long lastQueueWaitMs;
        public final long maxQueueWaitMs;
        public final long lastValidResponseAtMs;

        private Metrics(SerialCommandCoordinator coordinator) {
            state = !coordinator.running
                ? "STOPPED"
                : coordinator.degraded
                    ? "DEGRADED"
                    : coordinator.inFlight == null ? "READY" : "BUSY";
            queueDepth = coordinator.queue.size();
            maxQueueDepth = coordinator.maxQueueDepth.get();
            inFlight = coordinator.inFlight != null;
            blockedActuations = coordinator.reconciliationRequired.size();
            submitted = coordinator.submitted.get();
            completed = coordinator.completed.get();
            rejected = coordinator.rejected.get();
            writes = coordinator.writes.get();
            readRetries = coordinator.readRetries.get();
            timeouts = coordinator.timeouts.get();
            invalidFrames = coordinator.invalidFrames.get();
            discardedBytes = coordinator.discardedBytes.get();
            mismatchedFrames = coordinator.mismatchedFrames.get();
            echoes = coordinator.echoes.get();
            ioFailures = coordinator.ioFailures.get();
            reconnections = coordinator.reconnections.get();
            unknownActuations = coordinator.unknownActuations.get();
            lastQueueWaitMs = coordinator.lastQueueWaitMs.get();
            maxQueueWaitMs = coordinator.maxQueueWaitMs.get();
            lastValidResponseAtMs = coordinator.lastValidResponseAtMs.get();
        }
    }

    private static final class PendingCommand {
        private final String executionId;
        private final byte[] frame;
        private final OperationKind operationKind;
        private final long submittedAtMs;

        private PendingCommand(String executionId, byte[] frame, OperationKind operationKind) {
            this.executionId = executionId;
            this.frame = Arrays.copyOf(frame, frame.length);
            this.operationKind = operationKind;
            this.submittedAtMs = System.currentTimeMillis();
        }
    }

    private enum WaitState {
        RESPONSE,
        DRIVER_FAILURE,
        TIMEOUT,
        STOPPED
    }

    private final Transport transport;
    private final Listener listener;
    private final ArrayBlockingQueue<PendingCommand> queue;
    private final long responseTimeoutMs;
    private final long recoveryBackoffMs;
    private final Object responseMonitor = new Object();
    private final Set<String> reconciliationRequired = ConcurrentHashMap.newKeySet();
    private final AtomicLong submitted = new AtomicLong();
    private final AtomicLong completed = new AtomicLong();
    private final AtomicLong rejected = new AtomicLong();
    private final AtomicLong writes = new AtomicLong();
    private final AtomicLong readRetries = new AtomicLong();
    private final AtomicLong timeouts = new AtomicLong();
    private final AtomicLong invalidFrames = new AtomicLong();
    private final AtomicLong discardedBytes = new AtomicLong();
    private final AtomicLong mismatchedFrames = new AtomicLong();
    private final AtomicLong echoes = new AtomicLong();
    private final AtomicLong ioFailures = new AtomicLong();
    private final AtomicLong reconnections = new AtomicLong();
    private final AtomicLong unknownActuations = new AtomicLong();
    private final AtomicLong lastQueueWaitMs = new AtomicLong();
    private final AtomicLong maxQueueWaitMs = new AtomicLong();
    private final AtomicLong lastValidResponseAtMs = new AtomicLong();
    private final AtomicInteger maxQueueDepth = new AtomicInteger();

    private volatile boolean running = true;
    private volatile boolean degraded = false;
    private volatile boolean recoveryRequested = false;
    private volatile PendingCommand inFlight;
    private byte[] matchedResponse;
    private String activeDriverFailure = "";
    private final Thread worker;

    public SerialCommandCoordinator(
        Transport transport,
        Listener listener,
        int queueCapacity,
        long responseTimeoutMs,
        long recoveryBackoffMs
    ) {
        if (transport == null || listener == null) {
            throw new IllegalArgumentException("TRANSPORT_AND_LISTENER_REQUIRED");
        }
        this.transport = transport;
        this.listener = listener;
        this.queue = new ArrayBlockingQueue<>(Math.max(1, queueCapacity));
        this.responseTimeoutMs = Math.max(20L, responseTimeoutMs);
        this.recoveryBackoffMs = Math.max(0L, recoveryBackoffMs);
        worker = new Thread(this::workerLoop, "preddita-serial-coordinator");
        worker.start();
    }

    public boolean submit(String executionId, byte[] frame) {
        String safeExecutionId = executionId == null ? "" : executionId.trim();
        OperationKind operationKind = classify(frame);
        String validationError = validateRequest(safeExecutionId, frame, operationKind);
        if (!validationError.isEmpty()) {
            rejectImmediately(safeExecutionId, operationKind, validationError);
            return false;
        }
        if (!running) {
            rejectImmediately(safeExecutionId, operationKind, "COORDINATOR_STOPPED");
            return false;
        }
        if (degraded) {
            rejectImmediately(safeExecutionId, operationKind, "DRIVER_DEGRADED");
            return false;
        }

        PendingCommand command = new PendingCommand(safeExecutionId, frame, operationKind);
        if (operationKind == OperationKind.ACTUATION && isActuationBlocked(command)) {
            rejectImmediately(safeExecutionId, operationKind, "ACTUATION_RECONCILIATION_REQUIRED");
            return false;
        }
        if (!queue.offer(command)) {
            rejectImmediately(safeExecutionId, operationKind, "SERIAL_QUEUE_FULL");
            return false;
        }

        submitted.incrementAndGet();
        maxQueueDepth.accumulateAndGet(queue.size(), Math::max);
        return true;
    }

    public void onFrame(byte[] frame) {
        if (!hasValidBcc(frame)) {
            invalidFrames.incrementAndGet();
            return;
        }

        synchronized (responseMonitor) {
            PendingCommand active = inFlight;
            if (active == null) {
                mismatchedFrames.incrementAndGet();
                return;
            }
            if (Arrays.equals(frame, active.frame)) {
                echoes.incrementAndGet();
                return;
            }
            lastValidResponseAtMs.set(System.currentTimeMillis());
            if (!responseMatches(active.frame, frame)) {
                mismatchedFrames.incrementAndGet();
                return;
            }
            matchedResponse = Arrays.copyOf(frame, frame.length);
            responseMonitor.notifyAll();
        }
    }

    public void onDriverFailure(String errorCode) {
        degraded = true;
        recoveryRequested = true;
        synchronized (responseMonitor) {
            if (inFlight != null) {
                activeDriverFailure = sanitizeErrorCode(errorCode, "SERIAL_IO_FAILURE");
                responseMonitor.notifyAll();
            }
        }
        worker.interrupt();
    }

    public void markDriverReady() {
        degraded = false;
        recoveryRequested = false;
    }

    public void markDriverStarting() {
        degraded = true;
        recoveryRequested = false;
    }

    public void recordParserActivity(long invalidFrameDelta, long discardedByteDelta) {
        if (invalidFrameDelta > 0) invalidFrames.addAndGet(invalidFrameDelta);
        if (discardedByteDelta > 0) discardedBytes.addAndGet(discardedByteDelta);
    }

    public Metrics snapshotMetrics() {
        return new Metrics(this);
    }

    public void shutdown() {
        running = false;
        worker.interrupt();
        PendingCommand pending;
        while ((pending = queue.poll()) != null) {
            emit(result(pending, false, "COORDINATOR_STOPPED", null, 0, 0L, false));
        }
        synchronized (responseMonitor) {
            responseMonitor.notifyAll();
        }
    }

    private void workerLoop() {
        while (running) {
            try {
                PendingCommand command = queue.poll(100L, TimeUnit.MILLISECONDS);
                if (command != null) {
                    execute(command);
                } else if (recoveryRequested) {
                    recoverTransport();
                }
            } catch (InterruptedException ignored) {
                if (!running) break;
            } catch (RuntimeException error) {
                degraded = true;
            }
        }
    }

    private void execute(PendingCommand command) {
        long startedAtMs = System.currentTimeMillis();
        long queueWaitMs = Math.max(0L, startedAtMs - command.submittedAtMs);
        lastQueueWaitMs.set(queueWaitMs);
        maxQueueWaitMs.accumulateAndGet(queueWaitMs, Math::max);

        if (degraded) {
            emit(result(command, false, "DRIVER_DEGRADED", null, 0, queueWaitMs, false));
            return;
        }
        if (command.operationKind == OperationKind.ACTUATION && isActuationBlocked(command)) {
            emit(result(command, false, "ACTUATION_RECONCILIATION_REQUIRED", null, 0, queueWaitMs, false));
            return;
        }

        boolean recoveryUsed = false;
        if (!transport.isAvailable()) {
            recoveryUsed = true;
            if (!recoverTransport()) {
                emit(result(command, false, "DRIVER_UNAVAILABLE", null, 0, queueWaitMs, false));
                return;
            }
        }

        int maxAttempts = command.operationKind == OperationKind.READ
            ? READ_MAX_ATTEMPTS
            : OTHER_MAX_ATTEMPTS;
        for (int attempt = 1; attempt <= maxAttempts; attempt++) {
            prepareAttempt(command);
            try {
                transport.write(Arrays.copyOf(command.frame, command.frame.length));
                writes.incrementAndGet();
            } catch (Exception error) {
                ioFailures.incrementAndGet();
                clearAttempt(command);
                boolean recovered = recoveryUsed ? transport.isAvailable() : recoverTransport();
                recoveryUsed = true;
                if (command.operationKind == OperationKind.ACTUATION) {
                    blockActuation(command);
                    emit(result(command, false, "ACTUATION_OUTCOME_UNKNOWN", null, attempt, queueWaitMs, true));
                    return;
                }
                if (command.operationKind == OperationKind.READ && attempt < maxAttempts && recovered) {
                    readRetries.incrementAndGet();
                    continue;
                }
                if (!recovered) degraded = true;
                emit(result(command, false, "SERIAL_IO_FAILURE", null, attempt, queueWaitMs, false));
                return;
            }

            WaitState waitState = awaitResponse();
            byte[] response = consumeResponse(command);
            if (waitState == WaitState.RESPONSE && response != null) {
                reconcileAfterRead(command);
                emit(result(command, true, "", response, attempt, queueWaitMs, false));
                return;
            }

            if (waitState == WaitState.DRIVER_FAILURE) {
                ioFailures.incrementAndGet();
                boolean recovered = recoveryUsed ? transport.isAvailable() : recoverTransport();
                recoveryUsed = true;
                if (command.operationKind == OperationKind.ACTUATION) {
                    blockActuation(command);
                    emit(result(command, false, "ACTUATION_OUTCOME_UNKNOWN", null, attempt, queueWaitMs, true));
                    return;
                }
                if (command.operationKind == OperationKind.READ && attempt < maxAttempts && recovered) {
                    readRetries.incrementAndGet();
                    continue;
                }
                if (!recovered) degraded = true;
                emit(result(command, false, "SERIAL_IO_FAILURE", null, attempt, queueWaitMs, false));
                return;
            }

            if (waitState == WaitState.STOPPED) {
                if (command.operationKind == OperationKind.ACTUATION) {
                    blockActuation(command);
                    emit(result(command, false, "ACTUATION_OUTCOME_UNKNOWN", null, attempt, queueWaitMs, true));
                } else {
                    emit(result(command, false, "COORDINATOR_STOPPED", null, attempt, queueWaitMs, false));
                }
                return;
            }

            timeouts.incrementAndGet();
            if (command.operationKind == OperationKind.READ && attempt < maxAttempts) {
                readRetries.incrementAndGet();
                continue;
            }
            if (command.operationKind == OperationKind.ACTUATION) {
                blockActuation(command);
                emit(result(command, false, "ACTUATION_OUTCOME_UNKNOWN", null, attempt, queueWaitMs, true));
                return;
            }
            emit(result(command, false, "SERIAL_RESPONSE_TIMEOUT", null, attempt, queueWaitMs, false));
            return;
        }
    }

    private void prepareAttempt(PendingCommand command) {
        synchronized (responseMonitor) {
            inFlight = command;
            matchedResponse = null;
            activeDriverFailure = "";
        }
    }

    private WaitState awaitResponse() {
        long deadline = System.currentTimeMillis() + responseTimeoutMs;
        synchronized (responseMonitor) {
            while (running && matchedResponse == null && activeDriverFailure.isEmpty()) {
                long remaining = deadline - System.currentTimeMillis();
                if (remaining <= 0L) break;
                try {
                    responseMonitor.wait(remaining);
                } catch (InterruptedException ignored) {
                    if (!running) return WaitState.STOPPED;
                }
            }
            if (!running) return WaitState.STOPPED;
            if (matchedResponse != null) return WaitState.RESPONSE;
            if (!activeDriverFailure.isEmpty()) return WaitState.DRIVER_FAILURE;
            return WaitState.TIMEOUT;
        }
    }

    private byte[] consumeResponse(PendingCommand command) {
        synchronized (responseMonitor) {
            byte[] response = matchedResponse == null
                ? null
                : Arrays.copyOf(matchedResponse, matchedResponse.length);
            if (inFlight == command) inFlight = null;
            matchedResponse = null;
            activeDriverFailure = "";
            return response;
        }
    }

    private void clearAttempt(PendingCommand command) {
        synchronized (responseMonitor) {
            if (inFlight == command) inFlight = null;
            matchedResponse = null;
            activeDriverFailure = "";
        }
    }

    private boolean recoverTransport() {
        recoveryRequested = false;
        if (!running) return false;
        if (recoveryBackoffMs > 0L) {
            try {
                Thread.sleep(recoveryBackoffMs);
            } catch (InterruptedException ignored) {
                if (!running) return false;
            }
        }

        reconnections.incrementAndGet();
        boolean recovered = false;
        try {
            recovered = transport.recover() && transport.isAvailable();
        } catch (RuntimeException ignored) {
            recovered = false;
        }
        degraded = !recovered;
        recoveryRequested = false;
        return recovered;
    }

    private void reconcileAfterRead(PendingCommand command) {
        if (command.operationKind != OperationKind.READ || unsigned(command.frame[0]) != 0x80) return;
        int board = unsigned(command.frame[1]);
        int channel = unsigned(command.frame[2]);
        if (channel == 0) {
            String prefix = board + ":";
            reconciliationRequired.removeIf(key -> key.startsWith(prefix));
        } else {
            reconciliationRequired.remove(board + ":" + channel);
        }
    }

    private void blockActuation(PendingCommand command) {
        reconciliationRequired.add(actuationKey(command));
        unknownActuations.incrementAndGet();
    }

    private boolean isActuationBlocked(PendingCommand command) {
        int board = unsigned(command.frame[1]);
        String boardPrefix = board + ":";
        if (unsigned(command.frame[0]) == 0x9D) {
            for (String key : reconciliationRequired) {
                if (key.startsWith(boardPrefix)) return true;
            }
            return false;
        }
        return reconciliationRequired.contains(board + ":*")
            || reconciliationRequired.contains(actuationKey(command));
    }

    private String actuationKey(PendingCommand command) {
        int board = unsigned(command.frame[1]);
        return unsigned(command.frame[0]) == 0x9D
            ? board + ":*"
            : board + ":" + unsigned(command.frame[2]);
    }

    private Result result(
        PendingCommand command,
        boolean ok,
        String errorCode,
        byte[] response,
        int attempts,
        long queueWaitMs,
        boolean outcomeUnknown
    ) {
        long durationMs = Math.max(0L, System.currentTimeMillis() - command.submittedAtMs);
        return new Result(
            command.executionId,
            command.operationKind,
            ok,
            errorCode,
            response,
            attempts,
            queueWaitMs,
            durationMs,
            outcomeUnknown
        );
    }

    private void rejectImmediately(String executionId, OperationKind operationKind, String errorCode) {
        rejected.incrementAndGet();
        emit(new Result(
            executionId,
            operationKind,
            false,
            errorCode,
            null,
            0,
            0L,
            0L,
            false
        ));
    }

    private void emit(Result result) {
        if (result.isOk()) completed.incrementAndGet();
        try {
            listener.onResult(result);
        } catch (RuntimeException ignored) {
            // A UI callback cannot stop the physical bus worker.
        }
    }

    private static String validateRequest(
        String executionId,
        byte[] frame,
        OperationKind operationKind
    ) {
        if (!executionId.matches("[A-Za-z0-9][A-Za-z0-9_-]{0,79}")) {
            return "INVALID_EXECUTION_ID";
        }
        if (frame == null || frame.length != 5) return "INVALID_FRAME_LENGTH";
        if (!hasValidBcc(frame)) return "INVALID_FRAME_BCC";
        if (operationKind == null) return "UNSUPPORTED_SERIAL_COMMAND";
        return "";
    }

    private static OperationKind classify(byte[] frame) {
        if (frame == null || frame.length == 0) return null;
        switch (unsigned(frame[0])) {
            case 0x80:
            case 0x82:
                return OperationKind.READ;
            case 0x7A:
            case 0x7C:
            case 0x7F:
            case 0x8A:
            case 0x9A:
            case 0x9B:
            case 0x9D:
                return OperationKind.ACTUATION;
            case 0x7E:
            case 0x81:
            case 0x8D:
                return OperationKind.CONFIGURATION;
            default:
                return null;
        }
    }

    private static boolean responseMatches(byte[] request, byte[] response) {
        if (request == null || request.length != 5 || response == null || response.length < 5) {
            return false;
        }
        int requestCommand = unsigned(request[0]);
        int expectedResponseCommand = requestCommand == 0x9D ? 0x9E : requestCommand;
        if (unsigned(response[0]) != expectedResponseCommand) return false;
        if (unsigned(response[1]) != unsigned(request[1])) return false;
        int requestChannel = unsigned(request[2]);
        return requestCommand == 0x9D
            || requestChannel == 0
            || unsigned(response[2]) == requestChannel;
    }

    private static boolean hasValidBcc(byte[] frame) {
        if (frame == null || frame.length < 2) return false;
        int checksum = 0;
        for (byte value : frame) checksum ^= unsigned(value);
        return checksum == 0;
    }

    private static String sanitizeErrorCode(String value, String fallback) {
        String candidate = value == null ? "" : value.trim().toUpperCase();
        return candidate.matches("[A-Z0-9_]{1,64}") ? candidate : fallback;
    }

    private static int unsigned(byte value) {
        return value & 0xFF;
    }
}
