/**
 * Checks the receiver's pure logic on a desktop JVM, with simulated time in ms: RyuoDisplay.Protection
 * (timers, states, brightness, shift, what counts as a real change) and RyuoDisplay.controlMessage on
 * the bytes ryuo_display.control_unit() sends. Neither touches an Android class, so the stub
 * android.jar is needed only to compile. From the repo root, with the jar's build tools in place
 * (make receiver):
 *
 * <pre>
 * A=~/.cache/ryuo/android; D=$(mktemp -d)
 * java -m jdk.compiler/com.sun.tools.javac.Main -nowarn -source 17 -target 17 -cp $A/android-35/android.jar \
 *     -d $D receiver/RyuoDisplay.java docs/009-burn-in/ProtectionCheck.java
 * java -cp $D ProtectionCheck
 * </pre>
 */
public class ProtectionCheck {
    static int failures;

    static void check(boolean ok, String what) {
        if (!ok) {
            failures++;
            System.out.println("FAIL: " + what);
        } else {
            System.out.println("ok:   " + what);
        }
    }

    static boolean near(float actual, float expected) {
        return Math.abs(actual - expected) < 1e-4;
    }

    static RyuoDisplay.Protection started(long start) {
        RyuoDisplay.Protection protection = new RyuoDisplay.Protection();
        protection.start(start);
        // A settled floor of about 5 kB, as NVENC gives at 10 Mb/s.
        for (int frame = 0; frame < 40; frame++) {
            protection.frame(5000 + (frame % 4), start + frame * 500);
        }
        return protection;
    }

    public static void main(String[] args) {
        long t0 = 1_000_000;

        // Dim, black and wake.
        RyuoDisplay.Protection protection = started(t0);
        long last = t0;  // only the first (floorless) frame of started() is real
        protection.tick(last + 179_000);
        check(protection.state.equals("active") && protection.alpha(last + 179_000) == 1f, "active before 3 min idle");
        long dim = last + 180_000;
        protection.tick(dim);
        check(protection.state.equals("dimmed"), "dimmed at 3 min idle");
        check(protection.alpha(dim) == 1f && protection.fading(dim), "dim fades from full");
        protection.tick(dim + 500);
        check(near(protection.alpha(dim + 500), 1f - 0.5f * (1f - 0.15f)), "half way through the 1 s fade at backlight 1.0");
        protection.tick(dim + 1000);
        check(near(protection.alpha(dim + 1000), 0.15f) && !protection.fading(dim + 1000), "dimmed to 15 % of full at backlight 1.0");
        // Caret blinks: small, 500 ms apart, do not wake.
        for (int step = 0; step < 6; step++) {
            check(!protection.frame(5080, dim + 2000 + step * 500), "caret blink " + step + " does not wake");
        }
        protection.tick(dim + 6000);
        check(protection.state.equals("dimmed"), "still dimmed after caret blinks");
        // A clock tick 1 s apart with +500 bytes: not real.
        check(!protection.frame(5500, dim + 7300), "clock tick does not wake");
        long black = last + 600_000;
        protection.tick(black);
        check(protection.state.equals("black") && protection.fading(black), "black at 10 min idle, fading");
        protection.tick(black + 1000);
        check(protection.alpha(black + 1000) == 0f, "fully black after the fade");
        // Pointer move: 4 frames 16 ms apart, small.
        boolean woke = false;
        for (int step = 0; step < 4; step++) {
            woke |= protection.frame(5300, black + 5000 + step * 16);
            if (step < 3) {
                check(!woke, "pointer frame " + step + " alone does not wake");
            }
        }
        check(woke && protection.state.equals("active") && protection.alpha(black + 5048) == 1f, "4th rapid pointer frame wakes at once");

        // A caret blinking every 500 ms and a clock ticking every second, at every phase between
        // them, never make a run of 4 frames 400 ms apart or closer.
        for (int phase = 0; phase < 500; phase += 25) {
            RyuoDisplay.Protection blinking = started(t0);
            long t1 = t0 + 700_000;  // black since t0 + 600 s
            blinking.tick(t1);
            boolean any = false;
            for (int step = 0; step < 120; step++) {
                any |= blinking.frame(5080, t1 + step * 500L);
                if (step % 2 == 0) {
                    any |= blinking.frame(5450, t1 + step * 500L + phase + 1);
                }
                blinking.tick(t1 + step * 500L + 499);
            }
            check(!any && blinking.state.equals("black"), "caret + clock at phase " + phase + " ms stay black");
        }
        // Typing at about 3 keys/s wakes on the 4th key.
        RyuoDisplay.Protection typist = started(t0);
        typist.tick(t0 + 400_000);
        boolean typed = false;
        for (int step = 0; step < 4; step++) {
            typed = typist.frame(5100, t0 + 401_000 + step * 300L);
        }
        check(typed && typist.state.equals("active"), "typing at 300 ms per key wakes on the 4th key");

        // A big frame wakes at once.
        protection.tick(black + 5048 + 180_000);
        check(protection.state.equals("dimmed"), "dimmed again 3 min after the pointer");
        check(protection.frame(25_000, black + 5048 + 181_000), "a 20 kB-over-floor frame wakes");
        check(protection.alpha(black + 5048 + 181_000) == 1f, "wake is instant");

        // Dim level follows the backlight.
        protection = started(t0);
        protection.control("protect=1 backlight=0.5");
        check(near(protection.dimAlpha(), 0.30f), "backlight 0.5: 0.15/0.5 = 0.30");
        protection.control("backlight=0.2");
        check(near(protection.dimAlpha(), 0.40f), "backlight 0.2: 40 % of current");
        protection.control("backlight=0");
        check(protection.dimAlpha() == 1f, "backlight 0: no curtain");
        protection.control("backlight=1.5 junk protect");
        check(protection.backlight == 0f && protection.enabled, "out-of-range and malformed fields are ignored");

        // Shift: every 3 min through 8 offsets within 4 px.
        protection = started(t0);
        check(protection.dx() == 4 && protection.dy() == 0, "first offset");
        java.util.Set<String> seen = new java.util.HashSet<>();
        for (int step = 0; step < 8; step++) {
            long at = t0 + 180_000L * (step + 1);
            protection.frame(30_000, at - 1); // stay active
            protection.tick(at);
            check(Math.abs(protection.dx()) <= 4 && Math.abs(protection.dy()) <= 4, "offset " + step + " within 4 px");
            seen.add(protection.dx() + "," + protection.dy());
        }
        check(seen.size() == 8, "8 distinct offsets in 8 shifts");
        check(protection.status(t0 + 180_000L * 8).contains("shift=180"), "next shift in 180 s right after a shift");
        // Timers run without frames: a stalled stream still shifts and blacks.
        RyuoDisplay.Protection stalled = started(t0);
        stalled.tick(t0 + 3_600_000);
        check(stalled.state.equals("black"), "an hour without frames: black");
        // 20 shifts in an hour: offset 20 % 8 = 4 of the ring.
        check(stalled.dx() == -4 && stalled.dy() == 0, "shifted 20 times while stalled");

        // Refresh: every 5 min while active, 2 s black, instant; skipped while dimmed.
        protection = new RyuoDisplay.Protection();
        protection.start(t0);
        protection.frame(30_000, t0 + 299_000);
        protection.tick(t0 + 300_000);
        check(protection.state.equals("refresh") && protection.alpha(t0 + 300_000) == 0f, "refresh at 5 min, instantly black");
        check(!protection.frame(40_000, t0 + 300_500) && protection.state.equals("refresh"), "a real change does not end a refresh");
        protection.tick(t0 + 301_999);
        check(protection.state.equals("refresh"), "refresh lasts 2 s");
        protection.tick(t0 + 302_000);
        check(protection.state.equals("active") && protection.alpha(t0 + 302_000) == 1f, "back to full after 2 s");
        // Idle since t0 + 300.5 s: dimmed at 480.5 s; the 600 s refresh is skipped.
        protection.tick(t0 + 599_000);
        check(protection.state.equals("dimmed"), "dimmed before the next refresh");
        protection.tick(t0 + 600_000);
        check(protection.state.equals("dimmed"), "refresh skipped while dimmed");

        // Off: full brightness, no shift, no refresh; frames still count, so on again starts fresh.
        protection = started(t0);
        protection.control("protect=0");
        protection.tick(t0 + 900_000);
        check(protection.state.equals("off") && protection.alpha(t0 + 900_000) == 1f && protection.dx() == 0 && protection.dy() == 0, "off: full, centred");
        protection.frame(30_000, t0 + 900_100);
        protection.control("protect=1");
        protection.tick(t0 + 900_200);
        check(protection.state.equals("active"), "on again after a real change: active");
        protection.tick(t0 + 900_100 + 180_000);
        check(protection.state.equals("dimmed"), "dims 3 min after the last real change");

        // Status and frame report.
        protection = started(t0);
        String statusLine = protection.status(t0 + 39 * 500 + 12_000);
        check(statusLine.startsWith("protection state=active idle=31 shift=149"), "status line: " + statusLine);
        String report = protection.frameReport();
        check(report != null && report.startsWith("frames n=40 floor=5000 small=39 smallMax=3 big=1 bigMin=-1 rapid=0"), "report: " + report);
        check(protection.frameReport() == null, "no report without frames");
        protection.control("protect=0");
        protection.tick(t0 + 30_000);
        check(protection.status(t0 + 30_000).equals("protection state=off idle=30"), "off status has no shift: " + protection.status(t0 + 30_000));

        // Control messages, as ryuo_display.control_unit() sends them, cut by AccessUnitReader.
        byte[] aud = {0, 0, 0, 1, 0x46, 0x01, 0x50};
        byte[] text = "ryuo protect=0 backlight=0.392".getBytes(java.nio.charset.StandardCharsets.US_ASCII);
        java.io.ByteArrayOutputStream wire = new java.io.ByteArrayOutputStream();
        wire.writeBytes(aud);
        wire.writeBytes(new byte[] {0, 0, 0, 1, 48 << 1, 1});
        wire.writeBytes(text);
        wire.writeBytes(aud);
        wire.writeBytes(new byte[] {0, 0, 0, 1, 0x02, 0x01, 0x55, 0x55});
        wire.writeBytes(aud);
        try {
            RyuoDisplay.AccessUnitReader reader =
                    new RyuoDisplay.AccessUnitReader(new java.io.ByteArrayInputStream(wire.toByteArray()));
            byte[] first = reader.next();
            byte[] second = reader.next();
            check("protect=0 backlight=0.392".equals(RyuoDisplay.controlMessage(first)), "control unit parsed");
            check(RyuoDisplay.controlMessage(second) == null && RyuoDisplay.hasPictureData(second),
                    "a frame is not a control message");
            RyuoDisplay.Protection controlled = new RyuoDisplay.Protection();
            controlled.control(RyuoDisplay.controlMessage(first));
            check(!controlled.enabled && near(controlled.backlight, 0.392f), "control applied");
        } catch (java.io.IOException error) {
            check(false, "reader: " + error);
        }

        System.out.println(failures == 0 ? "ALL OK" : failures + " FAILED");
        System.exit(failures == 0 ? 0 : 1);
    }
}
