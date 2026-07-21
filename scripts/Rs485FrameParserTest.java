import com.preddita.entregaslocker.Rs485FrameParser;

import java.util.Arrays;
import java.util.List;

public final class Rs485FrameParserTest {
    private static byte[] frame(int... payload) {
        byte[] result = new byte[payload.length + 1];
        int checksum = 0;
        for (int index = 0; index < payload.length; index++) {
            result[index] = (byte) payload[index];
            checksum ^= payload[index] & 0xFF;
        }
        result[payload.length] = (byte) checksum;
        return result;
    }

    private static byte[] concat(byte[]... values) {
        int size = Arrays.stream(values).mapToInt(value -> value.length).sum();
        byte[] result = new byte[size];
        int offset = 0;
        for (byte[] value : values) {
            System.arraycopy(value, 0, result, offset, value.length);
            offset += value.length;
        }
        return result;
    }

    private static void assertFrame(byte[] actual, byte[] expected, String message) {
        if (!Arrays.equals(actual, expected)) {
            throw new AssertionError(message);
        }
    }

    private static void assertCount(List<byte[]> frames, int expected, String message) {
        if (frames.size() != expected) {
            throw new AssertionError(message + ": esperado=" + expected + " atual=" + frames.size());
        }
    }

    public static void main(String[] args) {
        byte[] firmware = frame(0x82, 0x01, 0x00, 0xAB);
        Rs485FrameParser fragmented = new Rs485FrameParser();
        assertCount(fragmented.append(firmware, 2), 0, "chunk parcial nao pode emitir frame");
        List<byte[]> fragmentedFrames = fragmented.append(
            Arrays.copyOfRange(firmware, 2, firmware.length),
            firmware.length - 2
        );
        assertCount(fragmentedFrames, 1, "segundo chunk deve completar o frame");
        assertFrame(fragmentedFrames.get(0), firmware, "frame fragmentado foi alterado");

        byte[] open = frame(0x8A, 0x01, 0x04, 0x00);
        byte[] close = frame(0x9B, 0x01, 0x04, 0x11);
        Rs485FrameParser combined = new Rs485FrameParser();
        List<byte[]> combinedFrames = combined.append(concat(open, close), open.length + close.length);
        assertCount(combinedFrames, 2, "frames colados devem ser separados");
        assertFrame(combinedFrames.get(0), open, "primeiro frame colado incorreto");
        assertFrame(combinedFrames.get(1), close, "segundo frame colado incorreto");

        byte[] invalid = Arrays.copyOf(open, open.length);
        invalid[invalid.length - 1] ^= 0x01;
        Rs485FrameParser resync = new Rs485FrameParser();
        byte[] noisy = concat(new byte[]{0x01, 0x02, 0x03}, invalid, firmware);
        List<byte[]> resynced = resync.append(noisy, noisy.length);
        assertCount(resynced, 1, "ruido e BCC invalido devem ser descartados");
        assertFrame(resynced.get(0), firmware, "parser nao resincronizou no frame valido");
        if (resync.invalidFrameCount() < 1) {
            throw new AssertionError("BCC invalido deve alimentar metrica do parser");
        }
        if (resync.discardedByteCount() < 4) {
            throw new AssertionError("ruido descartado deve alimentar metrica do parser");
        }

        byte[] readAllRequest = frame(0x80, 0x01, 0x00, 0x33);
        byte[] readAllResponse = frame(0x80, 0x01, 0xFF, 0xFF, 0xFF, 0x33);
        Rs485FrameParser readAll = new Rs485FrameParser();
        readAll.expectResponseFor(readAllRequest);
        byte[] echoAndPartial = concat(readAllRequest, Arrays.copyOfRange(readAllResponse, 0, 3));
        List<byte[]> firstReadAllFrames = readAll.append(echoAndPartial, echoAndPartial.length);
        assertCount(firstReadAllFrames, 1, "eco deve ser emitido sem consumir resposta parcial");
        assertFrame(firstReadAllFrames.get(0), readAllRequest, "eco da leitura geral incorreto");
        List<byte[]> completedReadAll = readAll.append(
            Arrays.copyOfRange(readAllResponse, 3, readAllResponse.length),
            readAllResponse.length - 3
        );
        assertCount(completedReadAll, 1, "resposta de leitura geral deve ter sete bytes");
        assertFrame(completedReadAll.get(0), readAllResponse, "resposta geral foi alterada");

        byte[] openAllRequest = frame(0x9D, 0x01, 0x01, 0x33);
        byte[] openAllResponse = frame(0x9E, 0x01, 0x00, 0x00, 0x00);
        Rs485FrameParser openAll = new Rs485FrameParser();
        openAll.expectResponseFor(openAllRequest);
        byte[] openAllEchoAndResponse = concat(openAllRequest, openAllResponse);
        List<byte[]> openAllFrames = openAll.append(openAllEchoAndResponse, openAllEchoAndResponse.length);
        assertCount(openAllFrames, 2, "eco 0x9D e resposta 0x9E devem ser separados");
        assertFrame(openAllFrames.get(0), openAllRequest, "eco 0x9D foi alterado");
        assertFrame(openAllFrames.get(1), openAllResponse, "resposta 0x9E foi alterada");

        System.out.println("PREDDITA_RS485_FRAME_PARSER_OK");
    }
}
