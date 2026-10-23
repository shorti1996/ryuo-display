import android.graphics.PixelFormat;
import android.media.MediaCodec;
import android.media.MediaFormat;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.view.Surface;
import android.view.SurfaceControl;
import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import java.util.Arrays;

/**
 * Shows an HEVC stream from the PC on the pump panel, on a layer above HomeUI.
 *
 * <p>Runs on the cooler without installing anything (the cooler's package installer hangs):
 *
 * <pre>
 * adb push receiver.jar /data/local/tmp/
 * adb shell CLASSPATH=/data/local/tmp/receiver.jar app_process / RyuoDisplay
 * adb forward tcp:27183 localabstract:ryuo-display
 * </pre>
 *
 * <p>Input is a raw Annex-B HEVC elementary stream with an access unit delimiter (NAL type 35)
 * before every frame, for example {@code ffmpeg ... -c:v hevc_nvenc -aud 1 -f hevc
 * tcp://127.0.0.1:27183}. The delimiters are how the stream is cut into frames for the decoder.
 * The layer is shown from the first decoded frame until the PC disconnects, then HomeUI is
 * visible again and the next connection is accepted.
 */
public class RyuoDisplay {
    static final String SOCKET_NAME = "ryuo-display";
    static final int WIDTH = 2240;
    static final int HEIGHT = 1080;
    static final int NAL_AUD = 35;

    public static void main(String[] args) throws Exception {
        SurfaceControl sc = new SurfaceControl.Builder()
                .setName("ryuo-display")
                .setBufferSize(WIDTH, HEIGHT)
                .setFormat(PixelFormat.RGBA_8888)
                .build();
        SurfaceControl.Transaction t = new SurfaceControl.Transaction();
        // Hidden API: a layer with no parent is on no display until given a layer stack.
        Method setLayerStack = SurfaceControl.Transaction.class
                .getMethod("setLayerStack", SurfaceControl.class, int.class);
        setLayerStack.invoke(t, sc, 0);
        t.setLayer(sc, Integer.MAX_VALUE - 1).setVisibility(sc, false).apply();
        Surface surface = new Surface(sc);

        LocalServerSocket server = new LocalServerSocket(SOCKET_NAME);
        log("listening on localabstract:" + SOCKET_NAME);
        while (true) {
            try (LocalSocket client = server.accept()) {
                log("client connected");
                play(client.getInputStream(), surface, sc);
            } catch (Exception e) {
                log("stream ended: " + e);
            }
            new SurfaceControl.Transaction().setVisibility(sc, false).apply();
            log("client gone, layer hidden");
        }
    }

    static void play(InputStream in, Surface surface, SurfaceControl sc) throws Exception {
        MediaFormat format = MediaFormat.createVideoFormat(
                MediaFormat.MIMETYPE_VIDEO_HEVC, WIDTH, HEIGHT);
        format.setInteger(MediaFormat.KEY_LOW_LATENCY, 1);
        MediaCodec codec = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_HEVC);
        log("decoder " + codec.getName());
        codec.configure(format, surface, null, 0);
        codec.start();

        Thread output = new Thread(() -> drain(codec, sc), "output");
        output.start();
        try {
            AccessUnitReader reader = new AccessUnitReader(in);
            byte[] au;
            while ((au = reader.next()) != null) {
                int index = codec.dequeueInputBuffer(-1);
                ByteBuffer buf = codec.getInputBuffer(index);
                buf.clear();
                buf.put(au);
                codec.queueInputBuffer(index, 0, au.length, System.nanoTime() / 1000, 0);
            }
        } finally {
            output.interrupt();
            output.join();
            codec.stop();
            codec.release();
        }
    }

    /** Renders every decoded frame as soon as it is ready; shows the layer on the first one. */
    static void drain(MediaCodec codec, SurfaceControl sc) {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        boolean shown = false;
        long frames = 0;
        long since = System.nanoTime();
        try {
            while (!Thread.currentThread().isInterrupted()) {
                int index = codec.dequeueOutputBuffer(info, 100_000);
                if (index < 0) {
                    continue;
                }
                codec.releaseOutputBuffer(index, true);
                if (!shown) {
                    new SurfaceControl.Transaction().setVisibility(sc, true).apply();
                    shown = true;
                    log("first frame, layer shown");
                }
                frames++;
                long now = System.nanoTime();
                if (now - since >= 5_000_000_000L) {
                    log(String.format("%.1f fps", frames * 1e9 / (now - since)));
                    frames = 0;
                    since = now;
                }
            }
        } catch (IllegalStateException e) {
            // The codec was stopped by play() while we were waiting for output.
        }
    }

    /** Cuts an Annex-B HEVC byte stream into access units at each access unit delimiter. */
    static class AccessUnitReader {
        private final InputStream in;
        private byte[] buf = new byte[1 << 20];
        private int len;
        private int scan;
        private boolean eof;

        AccessUnitReader(InputStream in) {
            this.in = in;
        }

        /** The next access unit, or null once the stream has ended. */
        byte[] next() throws IOException {
            while (true) {
                // Look for 00 00 01 followed by an AUD header, skipping the one at offset 0.
                for (; scan + 4 <= len; scan++) {
                    if (buf[scan] == 0 && buf[scan + 1] == 0 && buf[scan + 2] == 1
                            && ((buf[scan + 3] >> 1) & 0x3f) == NAL_AUD) {
                        // Cut before the extra zero of a 4-byte start code (00 00 00 01).
                        int cut = scan > 0 && buf[scan - 1] == 0 ? scan - 1 : scan;
                        if (cut > 0) {
                            return take(cut);
                        }
                    }
                }
                if (eof) {
                    return len > 0 ? take(len) : null;
                }
                if (len == buf.length) {
                    buf = Arrays.copyOf(buf, buf.length * 2);
                }
                int n = in.read(buf, len, buf.length - len);
                if (n < 0) {
                    eof = true;
                } else {
                    len += n;
                }
            }
        }

        private byte[] take(int end) {
            byte[] au = Arrays.copyOf(buf, end);
            System.arraycopy(buf, end, buf, 0, len - end);
            len -= end;
            scan = 1;
            return au;
        }
    }

    static void log(String msg) {
        System.out.println("ryuo-display: " + msg);
    }
}
