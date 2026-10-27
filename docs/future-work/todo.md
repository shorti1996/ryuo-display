# Future work

- **Second display: occasional stutter on a window or on pointer movement.** Since 9db04ef the mode works well in daily use, but now and then a window or the pointer stutters on the panel for a moment. Each capture restart (logged as `restarted the capture` in `journalctl --user -u ryuod`) freezes the panel for about 80 ms and starts a fresh keyframe, so the first check is whether the stutters line up with those log lines.
