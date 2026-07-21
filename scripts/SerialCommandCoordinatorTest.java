import com.preddita.entregaslocker.SerialCommandCoordinator;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

public final class SerialCommandCoordinatorTest {
    private static final long RESULT_TIMEOUT_MS = 2500L;

    private static byte[] frame(int command, int board, int channel, int value) {
        return new byte[]{
            (byte) command,
            (byte) board,
            (byte) channel,
            (byte) value,
            (byte) (command ^ board ^ channel ^ value),
        };
    }

    private static void assertTrue(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    private static void assertEquals(long actual, long expected, String message) {
        if (actual != expected) {
            throw new AssertionError(message + ": esperado=" + expected + " atual=" + actual);
        }
    }

    private static void assertEquals(String actual, String expected, String message) {
        if (!expected.equals(actual)) {
            throw new AssertionError(message + ": esperado=" + expected + " atual=" + actual);
        }
    }

    private static SerialCommandCoordinator.Result awaitResult(
        BlockingQueue<SerialCommandCoordinator.Result> results
    ) throws Exception {
        SerialCommandCoordinator.Result result = results.poll(RESULT_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        if (result == null) throw new AssertionError("coordenador nao publicou resultado no prazo");
        return result;
    }

    private static void testConcurrentRequestsUseOneWriter() throws Exception {
        BlockingQueue<SerialCommandCoordinator.Result> results = new LinkedBlockingQueue<>();
        AtomicReference<SerialCommandCoordinator> holder = new AtomicReference<>();
        AtomicInteger activeWrites = new AtomicInteger();
        AtomicInteger maxActiveWrites = new AtomicInteger();
        SerialCommandCoordinator coordinator = new SerialCommandCoordinator(
            new SerialCommandCoordinator.Transport() {
                @Override
                public boolean isAvailable() {
                    return true;
                }

                @Override
                public void write(byte[] request) throws Exception {
                    int active = activeWrites.incrementAndGet();
                    maxActiveWrites.accumulateAndGet(active, Math::max);
                    Thread.sleep(3L);
                    holder.get().onFrame(frame(0x80, request[1] & 0xFF, request[2] & 0xFF, 0x11));
                    activeWrites.decrementAndGet();
                }

                @Override
                public boolean recover() {
                    return true;
                }
            },
            results::offer,
            16,
            80L,
            0L
        );
        holder.set(coordinator);

        ExecutorService submitters = Executors.newFixedThreadPool(8);
        CountDownLatch ready = new CountDownLatch(8);
        CountDownLatch start = new CountDownLatch(1);
        for (int index = 1; index <= 8; index++) {
            final int channel = index;
            submitters.submit(() -> {
                ready.countDown();
                start.await();
                coordinator.submit("concurrent-" + channel, frame(0x80, 1, channel, 0x33));
                return null;
            });
        }
        assertTrue(ready.await(1L, TimeUnit.SECONDS), "submissores concorrentes nao ficaram prontos");
        start.countDown();
        submitters.shutdown();
        assertTrue(submitters.awaitTermination(1L, TimeUnit.SECONDS), "submissores nao terminaram");

        List<SerialCommandCoordinator.Result> completed = new ArrayList<>();
        for (int index = 0; index < 8; index++) completed.add(awaitResult(results));
        assertTrue(completed.stream().allMatch(SerialCommandCoordinator.Result::isOk), "todas as leituras devem concluir");
        assertEquals(maxActiveWrites.get(), 1L, "apenas uma escrita fisica pode ficar em voo");
        assertEquals(coordinator.snapshotMetrics().writes, 8L, "cada solicitacao deve escrever uma vez");
        coordinator.shutdown();
    }

    private static void testCorrelationRejectsOtherBoardAndChannel() throws Exception {
        BlockingQueue<SerialCommandCoordinator.Result> results = new LinkedBlockingQueue<>();
        AtomicReference<SerialCommandCoordinator> holder = new AtomicReference<>();
        SerialCommandCoordinator coordinator = new SerialCommandCoordinator(
            new SerialCommandCoordinator.Transport() {
                @Override
                public boolean isAvailable() {
                    return true;
                }

                @Override
                public void write(byte[] request) {
                    holder.get().onFrame(frame(0x80, 2, 4, 0x11));
                    holder.get().onFrame(frame(0x80, 1, 5, 0x11));
                    holder.get().onFrame(frame(0x80, 1, 4, 0x11));
                }

                @Override
                public boolean recover() {
                    return true;
                }
            },
            results::offer,
            4,
            80L,
            0L
        );
        holder.set(coordinator);
        coordinator.submit("correlation-1", frame(0x80, 1, 4, 0x33));
        assertTrue(awaitResult(results).isOk(), "somente a resposta correlacionada deve concluir");
        assertEquals(coordinator.snapshotMetrics().mismatchedFrames, 2L, "placa e canal incorretos devem ser contabilizados");
        coordinator.shutdown();
    }

    private static void testReadRetriesAfterTimeout() throws Exception {
        BlockingQueue<SerialCommandCoordinator.Result> results = new LinkedBlockingQueue<>();
        AtomicReference<SerialCommandCoordinator> holder = new AtomicReference<>();
        AtomicInteger writeCalls = new AtomicInteger();
        SerialCommandCoordinator coordinator = new SerialCommandCoordinator(
            new SerialCommandCoordinator.Transport() {
                @Override
                public boolean isAvailable() {
                    return true;
                }

                @Override
                public void write(byte[] request) {
                    if (writeCalls.incrementAndGet() == 2) {
                        holder.get().onFrame(frame(0x80, 1, 3, 0x11));
                    }
                }

                @Override
                public boolean recover() {
                    return true;
                }
            },
            results::offer,
            4,
            35L,
            0L
        );
        holder.set(coordinator);
        coordinator.submit("read-retry-1", frame(0x80, 1, 3, 0x33));
        SerialCommandCoordinator.Result result = awaitResult(results);
        assertTrue(result.isOk(), "segunda tentativa de leitura deve concluir");
        assertEquals(result.getAttempts(), 2L, "leitura deve registrar duas tentativas");
        assertEquals(writeCalls.get(), 2L, "leitura pode ser escrita novamente uma vez");
        assertEquals(coordinator.snapshotMetrics().readRetries, 1L, "retry de leitura deve ser observavel");
        coordinator.shutdown();
    }

    private static void testUnknownActuationRequiresSensorReconciliation() throws Exception {
        BlockingQueue<SerialCommandCoordinator.Result> results = new LinkedBlockingQueue<>();
        AtomicReference<SerialCommandCoordinator> holder = new AtomicReference<>();
        AtomicInteger actuationWrites = new AtomicInteger();
        SerialCommandCoordinator coordinator = new SerialCommandCoordinator(
            new SerialCommandCoordinator.Transport() {
                @Override
                public boolean isAvailable() {
                    return true;
                }

                @Override
                public void write(byte[] request) {
                    int command = request[0] & 0xFF;
                    if (command == 0x80) {
                        holder.get().onFrame(frame(0x80, 1, 6, 0x11));
                        return;
                    }
                    if (actuationWrites.incrementAndGet() > 1) {
                        holder.get().onFrame(frame(0x8A, 1, 6, 0x00));
                    }
                }

                @Override
                public boolean recover() {
                    return true;
                }
            },
            results::offer,
            8,
            35L,
            0L
        );
        holder.set(coordinator);

        coordinator.submit("actuation-unknown-1", frame(0x8A, 1, 6, 0x33));
        SerialCommandCoordinator.Result unknown = awaitResult(results);
        assertTrue(unknown.isExecutionOutcomeUnknown(), "timeout de atuacao deve ter resultado desconhecido");
        assertEquals(actuationWrites.get(), 1L, "atuacao incerta nunca pode ser repetida");

        assertTrue(!coordinator.submit("actuation-blocked-1", frame(0x8A, 1, 6, 0x33)), "canal incerto deve bloquear nova atuacao");
        assertEquals(awaitResult(results).getErrorCode(), "ACTUATION_RECONCILIATION_REQUIRED", "bloqueio deve ser explicito");
        assertEquals(actuationWrites.get(), 1L, "atuacao bloqueada nao pode tocar na UART");

        coordinator.submit("sensor-reconcile-1", frame(0x80, 1, 6, 0x33));
        assertTrue(awaitResult(results).isOk(), "leitura individual deve reconciliar o canal");
        coordinator.submit("actuation-after-read-1", frame(0x8A, 1, 6, 0x33));
        assertTrue(awaitResult(results).isOk(), "atuacao pode voltar depois da reconciliacao");
        assertEquals(actuationWrites.get(), 2L, "somente a nova atuacao confirmada deve ser escrita");
        coordinator.shutdown();
    }

    private static void testIoFailureReopensOnceAndRetriesOnlyRead() throws Exception {
        BlockingQueue<SerialCommandCoordinator.Result> results = new LinkedBlockingQueue<>();
        AtomicReference<SerialCommandCoordinator> holder = new AtomicReference<>();
        AtomicInteger writeCalls = new AtomicInteger();
        AtomicInteger recoverCalls = new AtomicInteger();
        SerialCommandCoordinator coordinator = new SerialCommandCoordinator(
            new SerialCommandCoordinator.Transport() {
                @Override
                public boolean isAvailable() {
                    return true;
                }

                @Override
                public void write(byte[] request) throws Exception {
                    if (writeCalls.incrementAndGet() == 1) throw new Exception("simulated I/O");
                    holder.get().onFrame(frame(0x80, 1, 2, 0x11));
                }

                @Override
                public boolean recover() {
                    recoverCalls.incrementAndGet();
                    return true;
                }
            },
            results::offer,
            4,
            50L,
            5L
        );
        holder.set(coordinator);
        coordinator.submit("io-read-1", frame(0x80, 1, 2, 0x33));
        assertTrue(awaitResult(results).isOk(), "leitura deve continuar depois da reabertura");
        assertEquals(writeCalls.get(), 2L, "somente leitura deve ser repetida");
        assertEquals(recoverCalls.get(), 1L, "driver deve ser reaberto no maximo uma vez");
        assertEquals(coordinator.snapshotMetrics().reconnections, 1L, "reabertura deve ser contabilizada");
        coordinator.shutdown();
    }

    private static void testFailedRecoveryDegradesAndClosesQueue() throws Exception {
        BlockingQueue<SerialCommandCoordinator.Result> results = new LinkedBlockingQueue<>();
        AtomicBoolean available = new AtomicBoolean(true);
        SerialCommandCoordinator coordinator = new SerialCommandCoordinator(
            new SerialCommandCoordinator.Transport() {
                @Override
                public boolean isAvailable() {
                    return available.get();
                }

                @Override
                public void write(byte[] request) throws Exception {
                    available.set(false);
                    throw new Exception("driver lost");
                }

                @Override
                public boolean recover() {
                    return false;
                }
            },
            results::offer,
            4,
            40L,
            0L
        );
        coordinator.submit("degraded-read-1", frame(0x80, 1, 1, 0x33));
        assertEquals(awaitResult(results).getErrorCode(), "SERIAL_IO_FAILURE", "falha de reabertura deve encerrar a leitura");
        assertEquals(coordinator.snapshotMetrics().state, "DEGRADED", "driver deve ficar degradado");
        assertTrue(!coordinator.submit("degraded-read-2", frame(0x80, 1, 1, 0x33)), "fila degradada deve falhar fechada");
        assertEquals(awaitResult(results).getErrorCode(), "DRIVER_DEGRADED", "nova solicitacao deve ser recusada");
        coordinator.shutdown();
    }

    private static void testFullQueueRejectsWithoutWriting() throws Exception {
        BlockingQueue<SerialCommandCoordinator.Result> results = new LinkedBlockingQueue<>();
        AtomicReference<SerialCommandCoordinator> holder = new AtomicReference<>();
        CountDownLatch firstWriteStarted = new CountDownLatch(1);
        CountDownLatch releaseFirstWrite = new CountDownLatch(1);
        AtomicInteger writeCalls = new AtomicInteger();
        SerialCommandCoordinator coordinator = new SerialCommandCoordinator(
            new SerialCommandCoordinator.Transport() {
                @Override
                public boolean isAvailable() {
                    return true;
                }

                @Override
                public void write(byte[] request) throws Exception {
                    if (writeCalls.incrementAndGet() == 1) {
                        firstWriteStarted.countDown();
                        releaseFirstWrite.await(1L, TimeUnit.SECONDS);
                    }
                    holder.get().onFrame(frame(0x80, 1, request[2] & 0xFF, 0x11));
                }

                @Override
                public boolean recover() {
                    return true;
                }
            },
            results::offer,
            1,
            80L,
            0L
        );
        holder.set(coordinator);
        coordinator.submit("queue-active-1", frame(0x80, 1, 1, 0x33));
        assertTrue(firstWriteStarted.await(1L, TimeUnit.SECONDS), "primeira escrita nao iniciou");
        assertTrue(coordinator.submit("queue-waiting-1", frame(0x80, 1, 2, 0x33)), "uma solicitacao deve caber na fila");
        assertTrue(!coordinator.submit("queue-full-1", frame(0x80, 1, 3, 0x33)), "fila cheia deve recusar nova solicitacao");
        assertEquals(awaitResult(results).getErrorCode(), "SERIAL_QUEUE_FULL", "recusa da fila deve ser explicita");
        assertEquals(writeCalls.get(), 1L, "item recusado nao pode chegar ao transporte");
        releaseFirstWrite.countDown();
        assertTrue(awaitResult(results).isOk(), "comando em voo deve concluir");
        assertTrue(awaitResult(results).isOk(), "comando que aguardava deve concluir");
        assertEquals(writeCalls.get(), 2L, "somente comandos aceitos devem escrever");
        coordinator.shutdown();
    }

    public static void main(String[] args) throws Exception {
        testConcurrentRequestsUseOneWriter();
        testCorrelationRejectsOtherBoardAndChannel();
        testReadRetriesAfterTimeout();
        testUnknownActuationRequiresSensorReconciliation();
        testIoFailureReopensOnceAndRetriesOnlyRead();
        testFailedRecoveryDegradesAndClosesQueue();
        testFullQueueRejectsWithoutWriting();
        System.out.println("PREDDITA_SERIAL_COMMAND_COORDINATOR_OK");
    }
}
