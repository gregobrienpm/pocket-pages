# CrossPoint changes for Pocket Pages

Pocket Pages works on standard [CrossPoint](https://crosspointreader.com). These two small changes make the end card look as designed:

1. **Headings honour an explicit font weight.** CrossPoint draws every heading in bold. With this change, a `<span style="font-weight: normal">` (or a class that sets it) inside a heading renders in regular weight, so the end card can mix bold and regular lines. Three unit tests cover it.
2. **Quick Resume (Dark) sleep screen.** A new Sleep Screen option that keeps the page you stopped on, like Quick Resume, but inverts it to white on black.

`crosspoint-pocketpages.patch` applies to CrossPoint 1.6.5 (`git apply`).

## Experimental build (X4 Pro only)

`crosspoint-1.6.5-pocketpages-x4pro.bin` is CrossPoint 1.6.5 with the patch, built for the **X4 Pro** (ESP32-S3).
SHA-256: `6d24878a7d122dbe88453d0de10f6265915616f6d1d53fa72f627d143fd62709`

To install: copy it to the SD card and use **Settings › System › SD Card Firmware Update**. To go back, use the official [CrossPoint web flasher](https://crosspointreader.com/#flash-tools).
This is unofficial and experimental. Use it at your own risk.

CrossPoint is MIT-licensed, copyright its contributors.
