package com.preddita.entregaslocker;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

public final class Rs485FrameParser {
    private static final int FIXED_FRAME_LENGTH = 5;
    private static final int READ_ALL_FRAME_LENGTH = 7;
    private static final int OPEN_ALL_FRAME_LENGTH = 6;
    private static final int MAX_BUFFER_SIZE = 256;
    private static final int[] KNOWN_COMMANDS = new int[]{
        0x7A, 0x7C, 0x7E, 0x7F, 0x80, 0x81, 0x82,
        0x8A, 0x8D, 0x9A, 0x9B, 0x9D, 0x9E
    };

    private final List<Byte> buffer = new ArrayList<>();
    private byte[] expectedRequest;
    private long invalidFrameCount;
    private long discardedByteCount;

    public synchronized void expectResponseFor(byte[] request) {
        expectedRequest = request == null ? null : Arrays.copyOf(request, request.length);
    }

    public synchronized void reset() {
        buffer.clear();
        expectedRequest = null;
    }

    public synchronized List<byte[]> append(byte[] chunk, int size) {
        int safeSize = chunk == null ? 0 : Math.max(0, Math.min(size, chunk.length));
        for (int index = 0; index < safeSize; index++) {
            buffer.add(chunk[index]);
        }
        trimOversizedBuffer();

        List<byte[]> frames = new ArrayList<>();
        while (!buffer.isEmpty()) {
            if (!isKnownCommand(unsigned(buffer.get(0)))) {
                buffer.remove(0);
                discardedByteCount += 1;
                continue;
            }

            int frameLength = expectedFrameLength();
            if (buffer.size() < frameLength) break;

            byte[] candidate = take(frameLength);
            if (!hasValidBcc(candidate)) {
                buffer.remove(0);
                invalidFrameCount += 1;
                discardedByteCount += 1;
                continue;
            }

            remove(frameLength);
            frames.add(candidate);
            updateExpectation(candidate);
        }
        return frames;
    }

    public synchronized int bufferedByteCount() {
        return buffer.size();
    }

    public synchronized long invalidFrameCount() {
        return invalidFrameCount;
    }

    public synchronized long discardedByteCount() {
        return discardedByteCount;
    }

    private int expectedFrameLength() {
        int command = unsigned(buffer.get(0));
        if (expectedRequest != null && expectedRequest.length == FIXED_FRAME_LENGTH) {
            int requestCommand = unsigned(expectedRequest[0]);
            int requestBoard = unsigned(expectedRequest[1]);
            int requestChannel = unsigned(expectedRequest[2]);
            int incomingBoard = buffer.size() > 1 ? unsigned(buffer.get(1)) : -1;

            if (incomingBoard == requestBoard && command == requestCommand) {
                if (isExactExpectedRequestPrefix()) return FIXED_FRAME_LENGTH;
                if (requestCommand == 0x80 && requestChannel == 0x00) return READ_ALL_FRAME_LENGTH;
                return FIXED_FRAME_LENGTH;
            }

            if (requestCommand == 0x9D && incomingBoard == requestBoard && command == 0x9E) {
                return OPEN_ALL_FRAME_LENGTH;
            }
        }

        return command == 0x9E ? OPEN_ALL_FRAME_LENGTH : FIXED_FRAME_LENGTH;
    }

    private boolean isExactExpectedRequestPrefix() {
        if (expectedRequest == null || buffer.size() < expectedRequest.length) return false;
        for (int index = 0; index < expectedRequest.length; index++) {
            if (buffer.get(index) != expectedRequest[index]) return false;
        }
        return true;
    }

    private void updateExpectation(byte[] frame) {
        if (expectedRequest == null || expectedRequest.length != FIXED_FRAME_LENGTH) return;
        if (Arrays.equals(frame, expectedRequest)) return;

        int requestCommand = unsigned(expectedRequest[0]);
        int requestBoard = unsigned(expectedRequest[1]);
        int requestChannel = unsigned(expectedRequest[2]);
        int responseCommand = unsigned(frame[0]);
        int responseBoard = frame.length > 1 ? unsigned(frame[1]) : -1;
        boolean commandMatches = responseCommand == requestCommand || (requestCommand == 0x9D && responseCommand == 0x9E);
        boolean channelMatches = requestChannel == 0x00 || frame.length < 3 || unsigned(frame[2]) == requestChannel;

        if (commandMatches && responseBoard == requestBoard && channelMatches) {
            expectedRequest = null;
        }
    }

    private void trimOversizedBuffer() {
        while (buffer.size() > MAX_BUFFER_SIZE) {
            buffer.remove(0);
            discardedByteCount += 1;
        }
    }

    private byte[] take(int size) {
        byte[] result = new byte[size];
        for (int index = 0; index < size; index++) {
            result[index] = buffer.get(index);
        }
        return result;
    }

    private void remove(int size) {
        for (int index = 0; index < size; index++) {
            buffer.remove(0);
        }
    }

    private static boolean hasValidBcc(byte[] frame) {
        int checksum = 0;
        for (byte value : frame) {
            checksum ^= unsigned(value);
        }
        return checksum == 0;
    }

    private static boolean isKnownCommand(int command) {
        for (int known : KNOWN_COMMANDS) {
            if (known == command) return true;
        }
        return false;
    }

    private static int unsigned(byte value) {
        return value & 0xFF;
    }
}
