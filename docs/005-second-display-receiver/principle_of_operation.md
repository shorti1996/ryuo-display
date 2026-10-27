# Second-display receiver: principle of operation

How `receiver/RyuoDisplay.java` shows the PC's HEVC stream on the pump panel without installing anything on the cooler.

The cooler runs the receiver the way scrcpy runs its server: a plain dex jar started with `app_process` from an adb shell. Android's package manager is never involved.

## Why no APK

`adb install` and on-device `pm install` (even with `--skip-verification`) hang forever on the cooler. Its PackageInstaller only ships an uninstall activity, so the install confirmation never arrives. Committed install sessions also survive `pm install-abandon` until the cooler reboots. The receiver avoids package installation completely.

## How Java runs without an app

ART (Android Runtime) is the virtual machine that runs Android's Java and Kotlin code, Android's equivalent of the JVM. It runs dex bytecode (`classes.dex`), not standard `.class` files. ART replaced the older Dalvik VM in Android 5.0; Dalvik used the same dex format.

`app_process` is the small native program that starts ART in a process, loads the framework classes, and calls a class's `main()`. Zygote is started by `app_process` too, and every normal Android app is a fork of zygote. Given a `CLASSPATH` and a class name, `app_process` starts ART in an ordinary process instead:

```
adb push receiver.jar /data/local/tmp/
adb shell CLASSPATH=/data/local/tmp/receiver.jar app_process / RyuoDisplay
```

The framework classes (`MediaCodec`, `SurfaceControl`, `LocalServerSocket`) are on the boot classpath, so the receiver can use them. There's no manifest, no package, and no permission grant. The process runs with the adb shell's identity, which is root on this cooler.

The receiver skips zygote, so it also misses what zygote loads before forking apps. One visible effect: `Paint.drawText` crashes, because the default typeface was never loaded.

## How the jar is built

The build needs no Android SDK install (`make receiver`, see the `receiver/receiver.jar` rule in `Makefile`):

1. `javac` compiles `receiver/RyuoDisplay.java` against the `android.jar` stub from platform-35. A JRE with the `jdk.compiler` module is enough: `java -m jdk.compiler/com.sun.tools.javac.Main`.
2. `d8` (from build-tools 35.0.1) turns the `.class` files into `classes.dex` inside `receiver/receiver.jar`.

Both zips are downloaded from dl.google.com on the first build and checked against their SHA-1. The built jar is committed, so a normal setup doesn't need the build tools.

## What the receiver does on the device

1. **Creates its own screen layer.** It builds a parentless `SurfaceControl` at 2240×1080. It calls the hidden `Transaction.setLayerStack(sc, 0)` through reflection to attach the layer to the main display, then puts it at layer `Integer.MAX_VALUE - 1` so it sits above HomeUI. The layer starts hidden. This draws straight into SurfaceFlinger, so no Activity or window is needed. The panel is landscape at this size, so no rotation is applied.
2. **Listens on an abstract Unix socket** named `ryuo-display`.
3. **Splits the byte stream into frames** (`AccessUnitReader`). The input is a raw Annex-B HEVC stream. Every frame starts with an access unit delimiter (NAL type 35), and the reader cuts the stream just before each one. Units that hold only a delimiter are dropped, because the decoder rejects them.
4. **Decodes on the hardware decoder.** `MediaCodec` (in practice `c2.rk.hevc.decoder`) is set up with `KEY_LOW_LATENCY` and renders directly into the layer's `Surface`, at about 60 fps.
5. **Shows and hides the layer.** The layer becomes visible on the first decoded frame, together with an opaque black layer under it (`ryuo-display-black`, drawn once with a software canvas). When the PC disconnects, both are hidden again, HomeUI shows through, and the receiver waits for the next connection.
6. **Protects the OLED panel from burn-in.** While the layer is shown, the receiver moves it a few pixels every 3 minutes and fades it towards the black layer when the desktop stays still. Units of NAL type 48 in the stream carry control messages from the PC (protection on or off, the backlight level) and never reach the decoder. See `docs/009-burn-in/`.

## Layering over HomeUI

HomeUI (`com.baiyi.homeui.hshomeui`) is the cooler's built-in app that plays uploaded videos, the screensaver clips and the stats overlay. The receiver does not replace it. HomeUI keeps running and playing underneath, and the receiver's full-screen layer covers it.

### How the screen is put together

On Android, apps don't draw to the screen themselves. Each window is a layer, and SurfaceFlinger (the system compositor) stacks all the layers for a display and blends them into each frame the panel shows.

- **Layer stack:** a number that ties layers to a display. The cooler's only display uses layer stack 0, so every layer on stack 0 ends up on the panel.
- **Z-order:** layers on the same stack are drawn bottom to top, by an integer z value.
- **WindowManager's tree:** normal app windows, HomeUI included, are not top-level layers. WindowManager nests them in its own tree (display → task → activity → window) and decides their order inside that tree. Only the root of that tree sits directly on the display.

### Where the receiver's layer goes

1. `new SurfaceControl.Builder()...build()` with no parent creates a layer outside WindowManager's tree. WindowManager doesn't know the layer exists, so it can't reorder or remove it.
2. `setLayerStack(sc, 0)`, called through reflection because the method is hidden, puts the layer directly on the panel's display, next to WindowManager's root. Without this step, a layer with no parent appears on no display.
3. `setLayer(sc, Integer.MAX_VALUE - 1)` gives it a z value near the maximum, so it is drawn above WindowManager's root and everything inside it.

```
top     ryuo-display layer (z = MAX_VALUE - 1), 2240×1080, moved up to 4 px and faded by the burn-in protection
        ryuo-display-black layer (z = MAX_VALUE - 2), 2240×1080, opaque black, shown with the layer above
        └─ WindowManager root
              └─ HomeUI: uploaded video, screensaver clip, stats overlay
bottom
```

The repo doesn't record why it uses `MAX_VALUE - 1` rather than `MAX_VALUE`.

### What happens to HomeUI

- **It doesn't notice anything.** Its activity stays in the foreground, keeps its own decoder, and goes on playing what ryuod selected and the 5-minute screensaver clips. While the receiver streams, ryuod selects a black still image (see "Black background during display mode" below). ryuod's heartbeats still reach it and it still answers them. The receiver's black layer is full screen and opaque, so none of HomeUI's pixels reach the panel.
- **Two hardware decoders run at once:** HomeUI's and the receiver's. That is why a leaked receiver decoder matters (see "Releasing the decoder" below): after a few leaks, HomeUI's next attempt to get a decoder fails.
- **Turning display mode off shows HomeUI again at once.** When the PC disconnects, the receiver sets the layer invisible. HomeUI was running all along, so whatever it is playing appears immediately. ryuod switches HomeUI from the black image back to the saved selection just before it stops `ryuo_display.py`, so by the time the layer goes, the saved video is already playing from its beginning.
- **The receiver's image hides HomeUI's burn-in protection.** The screensaver clip is HomeUI's way of changing the OLED picture, and it now plays under the receiver's layers, out of sight. The receiver has its own protection instead: `docs/009-burn-in/`.

## Black background during display mode

HomeUI's video keeps the cooler's decoder busy under the receiver's layer. Measured on 2026-10-24 by feeding a 2240×1080, 10 Mb/s test pattern straight to the receiver: it decoded at most about 70 fps with the 1920×960, 30 fps preset video playing behind it, and about 90 fps with a still image behind it. ryuod therefore puts HomeUI on a black still image while `ryuo_display.py` streams (class `Backdrop` in `ryuod.py`):

- **Switch:** when `ryuo_display.py` prints `streaming to the panel`, ryuod pushes `display-black.png` to `/sdcard/pcMedia/` with adb and sends `waterBlockScreenId` with that name as the whole playlist and six empty overlay slots, so HomeUI draws plain black. A change to the overlay while display mode runs is saved and sent with the restore (the API reply carries `heldByDisplay: true`). The file is a 2240×1080 black PNG of about 7 kB, generated with `zlib` and `struct` (`black_png()` in `ryuo_media.py`) and pushed again before every switch. HomeUI plays a `.mp4` name in a VideoView and any other name in an ImageView, so the `.png` extension makes it a still image. HomeUI looks up names starting with `RYUO` in the preset folder first; this name doesn't.
- **Restore:** after each `ryuo_display.py` run ends, whether the switch was turned off, the run failed and waits for a retry or stopped on an error, or ryuod is shutting down, ryuod sends `waterBlockScreenId` built from the saved selection: the same config the startup sequence sends. When ryuod stops the child (switch off, shutdown), the restore goes out before the stop begins, while the receiver's layer still covers HomeUI; stopping takes up to about 10 s, and the panel would otherwise show the black image for that long. HomeUI and the receiver hold a decoder each at that moment, as they did before the switch to black. When the child exits on its own, the restore follows the exit. On shutdown the restore goes out before `disconn`.
- **Saved selection:** the switch lives in ryuod's memory, and `state.json` keeps the user's selection, so after a crash or reboot HomeUI plays it again. While the switch is on, the startup sequence after a reconnect sends the black image. Choosing media, finishing an upload, or deleting a file in the playlist saves the new selection without sending it; the API reply carries `heldByDisplay: true` and the control page adds "applies when the second display is off".
- **Failed push:** display mode runs on with HomeUI's video behind it. The control page shows the adb error under Second display (`backgroundError` in the `display` status of `GET /api/state`) until a later switch succeeds or display mode is turned off.
- **Control page:** `display-black.png` is listed under Custom with a "second display" tag. It can be selected like any other file, but not deleted from the page.

## How the PC reaches it

```
KWin virtual output ─► GStreamer nvh265enc ─► ryuo_display.py ─► TCP 127.0.0.1:27183
   ─► adb forward ─► localabstract:ryuo-display ─► RyuoDisplay ─► MediaCodec ─► panel layer
```

`Session.start_receiver` in `ryuo_display.py`:

1. Pushes `receiver/receiver.jar` to `/data/local/tmp/receiver.jar`.
2. Kills any receiver left over from an earlier run, because it would still hold the socket name.
3. Runs `adb shell "echo pid=$$; export CLASSPATH=...; exec app_process / RyuoDisplay"`. The `exec` replaces the shell with the receiver, so the printed pid is the receiver's own and can be killed later.
4. Waits for the receiver's `listening` line, then runs `adb forward tcp:27183 localabstract:ryuo-display`.

## Each frame carries the next frame's delimiter

The receiver only knows a frame is complete when the next delimiter arrives. KWin sends nothing while the desktop is still, so without help the last frame could sit undisplayed for minutes. `panel_frame()` in `ryuo_display.py` sends each frame without its own leading delimiter and appends the delimiter of the next frame. The stream stays valid HEVC.

## Releasing the decoder

If the receiver is killed while it holds the decoder, the cooler's codec service keeps the decoder allocated. After a few leaks no decoder is left, and HomeUI shows "Can't play this video." Two measures prevent this:

- The receiver calls `codec.release()` in a `finally` block, even when `codec.stop()` throws.
- On shutdown, the PC side closes the socket first, gives the receiver up to 5 s to release the decoder itself, and only then kills it.

If a decoder leaks anyway, restart the codec service:

```
adb shell setprop ctl.restart android-hardware-media-c2-hal-1-1
```

A related failure: feeding the decoder a junk input buffer (for example a lone `0x00` left over when a 4-byte start code is split) stalls it for good. It holds all 4 input buffers and never outputs a frame. The reader avoids this by cutting before the extra zero of a 4-byte start code.

## Watching it run

```
journalctl --user -u ryuod -f | grep ryuo-display
```

The receiver logs `listening`, `black layer ready`, `client connected`, `first frame, layer shown`, `control: ...` for each control message, each change of its burn-in protection state, and `client gone, layer hidden` when the PC disconnects. ryuod prefixes each line with `display:`. The receiver also prints its frame rate, its protection state and the sizes of the frames it got every 5 s, but ryuod only passes those lines to the journal when it runs with `-v` (`make run`); the latter two are also in `GET /api/state` under `display.protection`.
