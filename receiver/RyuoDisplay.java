import android.graphics.Canvas;
import android.graphics.Color;
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
import java.nio.charset.StandardCharsets;
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
 *
 * <p>An opaque black layer sits under the video layer while it is shown, and {@link Protection}
 * moves and dims the video against it so the OLED panel does not burn in. The PC can send control
 * messages between frames, as NAL units of type 48 (see {@link #controlMessage}).
 */
public class RyuoDisplay {
    static final String SOCKET_NAME = "ryuo-display";
    static final int WIDTH = 2240;
    static final int HEIGHT = 1080;
    static final int NAL_AUD = 35;
    // HEVC leaves NAL types 48-63 unspecified, for applications. The PC sends its control messages
    // as type 48, each in an access unit of its own, which never reaches the decoder.
    static final int NAL_CONTROL = 48;
    static final String CONTROL_PREFIX = "ryuo ";

    // Kept so the black layer's buffer producer stays connected for the life of the process.
    static Surface blackSurface;

    public static void main(String[] args) throws Exception {
        SurfaceControl sc = new SurfaceControl.Builder()
                .setName("ryuo-display")
                .setBufferSize(WIDTH, HEIGHT)
                .setFormat(PixelFormat.RGBA_8888)
                .build();
        SurfaceControl black = new SurfaceControl.Builder()
                .setName("ryuo-display-black")
                .setBufferSize(WIDTH, HEIGHT)
                .setFormat(PixelFormat.RGBX_8888)
                .setOpaque(true)
                .build();
        SurfaceControl.Transaction setup = new SurfaceControl.Transaction();
        // Hidden API: a layer with no parent is on no display until given a layer stack.
        Method setLayerStack = SurfaceControl.Transaction.class
                .getMethod("setLayerStack", SurfaceControl.class, int.class);
        setLayerStack.invoke(setup, sc, 0);
        setLayerStack.invoke(setup, black, 0);
        setup.setLayer(black, Integer.MAX_VALUE - 2).setVisibility(black, false)
                .setLayer(sc, Integer.MAX_VALUE - 1).setVisibility(sc, false).apply();
        fillBlack(black);
        Surface surface = new Surface(sc);
        Panel panel = new Panel(sc, black);
        Thread timers = new Thread(panel::run, "protection");
        timers.setDaemon(true);
        timers.start();

        LocalServerSocket server = new LocalServerSocket(SOCKET_NAME);
        log("listening on localabstract:" + SOCKET_NAME);
        while (true) {
            try (LocalSocket client = server.accept()) {
                log("client connected");
                play(client.getInputStream(), surface, panel);
            } catch (Exception e) {
                log("stream ended: " + e);
            }
            panel.hide();
            log("client gone, layer hidden");
        }
    }

    /** Draws the black layer's one buffer with a software canvas; it is never redrawn. */
    static void fillBlack(SurfaceControl black) {
        blackSurface = new Surface(black);
        try {
            Canvas canvas = blackSurface.lockCanvas(null);
            canvas.drawColor(Color.BLACK);
            blackSurface.unlockCanvasAndPost(canvas);
            log("black layer ready");
        } catch (RuntimeException error) {
            // Display mode still works; the edge the shift uncovers and the dimmed picture then
            // show HomeUI's own black image instead of this layer.
            log("black layer failed: " + error);
        }
    }

    static void play(InputStream in, Surface surface, Panel panel) throws Exception {
        MediaFormat format = MediaFormat.createVideoFormat(
                MediaFormat.MIMETYPE_VIDEO_HEVC, WIDTH, HEIGHT);
        format.setInteger(MediaFormat.KEY_LOW_LATENCY, 1);
        MediaCodec codec = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_HEVC);
        log("decoder " + codec.getName());
        codec.configure(format, surface, null, 0);
        codec.start();

        Thread output = new Thread(() -> drain(codec, panel), "output");
        output.start();
        try {
            AccessUnitReader reader = new AccessUnitReader(in);
            byte[] au;
            while ((au = reader.next()) != null) {
                String control = controlMessage(au);
                if (control != null) {
                    panel.control(control);
                    continue;
                }
                // A sender may put the next frame's delimiter right after each frame, so the
                // stream can end with a delimiter and nothing else; the decoder rejects that.
                if (!hasPictureData(au)) {
                    continue;
                }
                panel.frame(au.length);
                int index = codec.dequeueInputBuffer(-1);
                ByteBuffer buf = codec.getInputBuffer(index);
                buf.clear();
                buf.put(au);
                codec.queueInputBuffer(index, 0, au.length, System.nanoTime() / 1000, 0);
            }
        } finally {
            output.interrupt();
            output.join();
            // release() must run even when stop() throws (a codec in its error state does).
            // A component that is never released stays allocated in the codec service after
            // this process dies, and a few of those leave no decoder for anyone, HomeUI included.
            try {
                codec.stop();
            } catch (RuntimeException e) {
                log("codec stop failed: " + e);
            } finally {
                codec.release();
            }
        }
    }

    /** True if the access unit holds a NAL unit other than an access unit delimiter. */
    static boolean hasPictureData(byte[] au) {
        for (int i = 0; i + 3 < au.length; i++) {
            if (au[i] == 0 && au[i + 1] == 0 && au[i + 2] == 1 && ((au[i + 3] >> 1) & 0x3f) != NAL_AUD) {
                return true;
            }
        }
        return false;
    }

    /**
     * The text of a control message from the PC, or null if the access unit is not one.
     *
     * <p>A control message is a NAL unit of type NAL_CONTROL whose payload, after the 2-byte NAL
     * header, is ASCII starting with CONTROL_PREFIX, such as {@code ryuo protect=1 backlight=0.980}.
     * ASCII has no zero bytes, so the payload can never contain a start code.
     */
    static String controlMessage(byte[] au) {
        for (int pos = 0; pos + 4 < au.length; pos++) {
            if (au[pos] == 0 && au[pos + 1] == 0 && au[pos + 2] == 1
                    && ((au[pos + 3] >> 1) & 0x3f) == NAL_CONTROL) {
                int start = pos + 5;
                int end = start;
                while (end < au.length && au[end] != 0) {
                    end++;
                }
                String text = new String(au, start, end - start, StandardCharsets.US_ASCII);
                return text.startsWith(CONTROL_PREFIX) ? text.substring(CONTROL_PREFIX.length()) : null;
            }
        }
        return null;
    }

    /** Renders every decoded frame as soon as it is ready; shows the layer on the first one. */
    static void drain(MediaCodec codec, Panel panel) {
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
                    panel.show();
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

    /**
     * The video layer and the black layer under it, positioned and faded as {@link Protection}
     * says. Every method that changes the layers holds this object's lock, so transactions from the
     * stream, the decoder output and the timer thread never interleave.
     */
    static class Panel {
        static final long TICK_MS = 250;  // timer thread period while nothing fades
        static final long FADE_STEP_MS = 33;  // timer thread period during a fade: about 30 steps/s
        static final long REPORT_EVERY_MS = 5_000;  // status and frame-size lines, besides state changes

        final SurfaceControl video;
        final SurfaceControl black;
        final Protection protection = new Protection();
        private boolean shown;
        private float alpha = 1f;
        private int offsetX;
        private int offsetY;
        private String reported;
        private long nextReport;

        Panel(SurfaceControl video, SurfaceControl black) {
            this.video = video;
            this.black = black;
        }

        static long now() {
            return System.nanoTime() / 1_000_000;
        }

        synchronized void show() {
            long now = now();
            protection.start(now);
            shown = true;
            alpha = 1f;
            offsetX = offsetY = 0;
            reported = null;
            nextReport = now + REPORT_EVERY_MS;
            new SurfaceControl.Transaction().setAlpha(video, 1f).setPosition(video, 0, 0)
                    .setVisibility(black, true).setVisibility(video, true).apply();
            update();
        }

        synchronized void hide() {
            shown = false;
            new SurfaceControl.Transaction().setVisibility(video, false).setVisibility(black, false).apply();
        }

        synchronized void frame(int bytes) {
            if (protection.frame(bytes, now()) && shown) {
                update();
            }
        }

        synchronized void control(String text) {
            protection.control(text);
            log("control: " + text);
            if (shown) {
                update();
            }
        }

        /** Brings the layers to what the protection wants now and prints its state. Lock held. */
        private void update() {
            long now = now();
            protection.tick(now);
            float wantAlpha = protection.alpha(now);
            int wantX = protection.dx();
            int wantY = protection.dy();
            if (wantAlpha != alpha || wantX != offsetX || wantY != offsetY) {
                new SurfaceControl.Transaction().setAlpha(video, wantAlpha)
                        .setPosition(video, wantX, wantY).apply();
                alpha = wantAlpha;
                offsetX = wantX;
                offsetY = wantY;
            }
            boolean due = now >= nextReport;
            if (due || !protection.state.equals(reported)) {
                log(protection.status(now));
                reported = protection.state;
            }
            if (due) {
                String sizes = protection.frameReport();
                if (sizes != null) {
                    log(sizes);
                }
                nextReport = now + REPORT_EVERY_MS;
            }
        }

        /** The timer thread: runs the protection while no frames come (a still desktop, a PC asleep). */
        void run() {
            synchronized (this) {
                while (true) {
                    if (shown) {
                        update();
                    }
                    try {
                        wait(shown && protection.fading(now()) ? FADE_STEP_MS : TICK_MS);
                    } catch (InterruptedException interrupted) {
                        return;
                    }
                }
            }
        }
    }

    /**
     * Anti burn-in timers and state for the mirrored desktop. Pure logic on times in ms passed in
     * by the caller, with no Android calls, so it also runs on a desktop JVM.
     *
     * <ul>
     *   <li>Shift: the picture moves to the next offset in SHIFTS every SHIFT_EVERY_MS; the black
     *       layer under it fills the uncovered edge.
     *   <li>Dim: after DIM_AFTER_MS without a real change, the picture fades over FADE_MS to
     *       min(DIM_SHARE x current, DIM_CAP x full) brightness.
     *   <li>Black: after BLACK_AFTER_MS without a real change, it fades to black.
     *   <li>Refresh: every REFRESH_EVERY_MS the picture is black for REFRESH_MS, even while the
     *       desktop changes; skipped while dimmed or black.
     *   <li>Wake: a real change brings the picture back to full brightness at once.
     * </ul>
     *
     * <p>Brightness is the video layer's alpha over the opaque black layer: alpha a shows a share a
     * of the backlight, the same as a black curtain of alpha 1 - a over the picture. The backlight
     * itself is never touched.
     *
     * <p>A real change is a frame at least REAL_EXCESS_BYTES larger than the smallest of the last
     * FLOOR_FRAMES frames, or the RAPID_FRAMES-th of frames each within RAPID_GAP_MS of the one
     * before. The PC's encoder (NVENC, constant bitrate) spends a fixed amount on every frame
     * whatever changed, about 5 kB at 10 Mb/s, and a caret blink, a clock tick or a short pointer
     * move each add only 60-600 bytes to that; pointer moves are told apart by their rate instead.
     */
    static class Protection {
        static final long SHIFT_EVERY_MS = 180_000;
        static final long DIM_AFTER_MS = 180_000;
        static final long BLACK_AFTER_MS = 600_000;
        static final long REFRESH_EVERY_MS = 300_000;
        static final long REFRESH_MS = 2_000;
        static final long FADE_MS = 1_000;
        static final float DIM_SHARE = 0.40f;  // of the current brightness
        static final float DIM_CAP = 0.15f;  // of full brightness
        static final int REAL_EXCESS_BYTES = 2_000;
        static final int FLOOR_FRAMES = 32;
        static final int RAPID_FRAMES = 4;
        // Under a caret's 500 ms blink, above a typist's ~300 ms between keys: a blinking caret and a
        // clock ticking once a second together give runs of 3 frames at most.
        static final long RAPID_GAP_MS = 400;
        // A ring of 8 offsets in px, none more than 4 px from the centre on either axis.
        static final int[][] SHIFTS = {{4, 0}, {3, 3}, {0, 4}, {-3, 3}, {-4, 0}, {-3, -3}, {0, -4}, {3, -3}};

        boolean enabled = true;  // until the PC says otherwise: a missing control link means on
        float backlight = 1f;  // the panel's backlight as a share of full; 1 until the PC says
        String state = "active";  // active, dimmed, black, refresh, or off when disabled

        private boolean started;
        private long lastReal;
        private long nextShift;
        private int shift;
        private long nextRefresh;
        private long refreshUntil;
        private float alphaFrom = 1f;
        private float alphaTo = 1f;
        private long fadeStart;

        private final int[] recent = new int[FLOOR_FRAMES];
        private int recentCount;
        private int recentNext;
        private long lastFrame;
        private int run;

        // Frame sizes since the last frameReport(), for tuning REAL_EXCESS_BYTES.
        private int frames;
        private int small;
        private int smallMax = -1;
        private int big;
        private int bigMin = -1;
        private int rapid;

        /** A new connection: the timers start over, except the shift, which keeps its place. */
        void start(long now) {
            lastReal = now;
            nextRefresh = now + REFRESH_EVERY_MS;
            refreshUntil = now;
            if (!started) {
                nextShift = now + SHIFT_EVERY_MS;
                started = true;
            }
            // A new encoder has its own floor.
            recentCount = recentNext = 0;
            run = 0;
            lastFrame = now - RAPID_GAP_MS;
            setAlpha(1f, now, true);
            state = enabled ? "active" : "off";
        }

        /** Applies "protect=0|1" and "backlight=0.0-1.0" fields; others are ignored. */
        void control(String text) {
            for (String field : text.trim().split(" +")) {
                int eq = field.indexOf('=');
                if (eq < 0) {
                    continue;
                }
                String key = field.substring(0, eq);
                String value = field.substring(eq + 1);
                try {
                    if (key.equals("protect")) {
                        enabled = !value.equals("0");
                    } else if (key.equals("backlight")) {
                        float share = Float.parseFloat(value);
                        if (share >= 0f && share <= 1f) {
                            backlight = share;
                        }
                    }
                } catch (NumberFormatException invalid) {
                    // Keep the previous value.
                }
            }
        }

        /** Notes a frame of `bytes`; true if it woke a dimmed or black picture. */
        boolean frame(int bytes, long now) {
            int floor = Integer.MAX_VALUE;
            for (int index = 0; index < recentCount; index++) {
                floor = Math.min(floor, recent[index]);
            }
            recent[recentNext] = bytes;
            recentNext = (recentNext + 1) % FLOOR_FRAMES;
            recentCount = Math.min(recentCount + 1, FLOOR_FRAMES);
            run = now - lastFrame < RAPID_GAP_MS ? run + 1 : 1;
            lastFrame = now;

            frames++;
            boolean isBig = floor == Integer.MAX_VALUE || bytes - floor >= REAL_EXCESS_BYTES;
            if (floor != Integer.MAX_VALUE) {
                int excess = bytes - floor;
                if (isBig) {
                    big++;
                    bigMin = bigMin < 0 ? excess : Math.min(bigMin, excess);
                } else {
                    small++;
                    smallMax = Math.max(smallMax, excess);
                }
            } else {
                big++;
            }
            boolean isRapid = run >= RAPID_FRAMES;
            if (isRapid && !isBig) {
                rapid++;
            }
            if (!isBig && !isRapid) {
                return false;
            }
            lastReal = now;
            if (enabled && (state.equals("dimmed") || state.equals("black"))) {
                state = "active";
                setAlpha(1f, now, true);
                return true;
            }
            return false;
        }

        /** Advances the timers to `now` and sets the state and the brightness it wants. */
        void tick(long now) {
            if (started && now >= nextShift) {
                long steps = (now - nextShift) / SHIFT_EVERY_MS + 1;
                shift = (int) ((shift + steps) % SHIFTS.length);
                nextShift += steps * SHIFT_EVERY_MS;
            }
            long idle = now - lastReal;
            if (now >= nextRefresh) {
                nextRefresh += ((now - nextRefresh) / REFRESH_EVERY_MS + 1) * REFRESH_EVERY_MS;
                if (enabled && idle < DIM_AFTER_MS) {
                    refreshUntil = now + REFRESH_MS;
                }
            }
            if (!enabled) {
                state = "off";
                setAlpha(1f, now, true);
            } else if (now < refreshUntil) {
                state = "refresh";
                setAlpha(0f, now, true);
            } else if (idle >= BLACK_AFTER_MS) {
                state = "black";
                setAlpha(0f, now, false);
            } else if (idle >= DIM_AFTER_MS) {
                state = "dimmed";
                setAlpha(dimAlpha(), now, false);
            } else {
                state = "active";
                setAlpha(1f, now, true);
            }
        }

        /** The video's alpha while dimmed: min(DIM_SHARE x current, DIM_CAP) / current. */
        float dimAlpha() {
            if (backlight <= 0f) {
                return 1f;
            }
            return Math.min(DIM_SHARE * backlight, DIM_CAP) / backlight;
        }

        private void setAlpha(float target, long now, boolean instant) {
            if (instant) {
                alphaFrom = alphaTo = target;
            } else if (target != alphaTo) {
                alphaFrom = alpha(now);
                alphaTo = target;
                fadeStart = now;
            }
        }

        float alpha(long now) {
            float progress = Math.max(0f, Math.min(1f, (now - fadeStart) / (float) FADE_MS));
            return alphaFrom + (alphaTo - alphaFrom) * progress;
        }

        boolean fading(long now) {
            return alphaFrom != alphaTo && now - fadeStart < FADE_MS;
        }

        int dx() {
            return enabled ? SHIFTS[shift][0] : 0;
        }

        int dy() {
            return enabled ? SHIFTS[shift][1] : 0;
        }

        /** "protection state=S idle=N shift=M": seconds since the last real change and to the next shift. */
        String status(long now) {
            String out = "protection state=" + state + " idle=" + Math.max(0, (now - lastReal) / 1000);
            if (enabled) {
                out += " shift=" + Math.max(0, (nextShift - now + 999) / 1000);
            }
            return out;
        }

        /**
         * Frame sizes since the last call, or null if no frame came: the floor, how many frames were
         * small (less than REAL_EXCESS_BYTES over the floor) and the largest excess among them, how
         * many were big and the smallest excess among those, and how many small frames counted as
         * real by their rate. -1 stands for none.
         */
        String frameReport() {
            if (frames == 0) {
                return null;
            }
            int floor = -1;
            for (int index = 0; index < recentCount; index++) {
                floor = floor < 0 ? recent[index] : Math.min(floor, recent[index]);
            }
            String out = "frames n=" + frames + " floor=" + floor + " small=" + small + " smallMax=" + smallMax
                    + " big=" + big + " bigMin=" + bigMin + " rapid=" + rapid;
            frames = small = big = rapid = 0;
            smallMax = bigMin = -1;
            return out;
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
