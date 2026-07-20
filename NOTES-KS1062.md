# KS1062 Research Notes

## Hardware confirmed from the device label

- Model: `KS1062-N-ZY`
- SoC: `RK3562`
- Memory / storage: `2 GB / 16 GB`
- Input power: `DC 12V 4A`
- Android version observed on the device: `Android 11`
- Serial validated on the current device and first app candidate: `/dev/ttyS5`
- Hardware variants may expose COM1 as `/dev/ttyS1`; confirm with diagnostics
  and commissioning instead of assuming a fixed mapping

## Management panel observed on the device

The built-in management screen is a blue button dashboard with these functions:

- System navigation bar control
- Screen orientation control
- Screen backlight control
- Timed power on / off interface
- System screenshot interface
- Restore factory settings
- User GPIO interface
- Ethernet parameter settings
- Wi-Fi parameter settings
- Wireless ADB control
- Set system time
- Device kernel information
- MCU
- Customer customization

That makes it clear the stock software is a device-management console, not a locker-operator screen.

## Protocol findings from `锁板协议2025(2).docx`

Primary communication settings:

- Interface: `RS-485`
- Baud rate: `9600`
- Parity: `N`
- Data bits: `8`
- Stop bits: `1`
- Check byte: XOR of command, board address, channel, and parameter

Main commands relevant to the locker UI:

- `0x80 board channel 0x33` -> read a single lock state
- `0x80 board 0x00 0x33` -> read all lock states for the board
- `0x8A board channel 0x33` -> unlock a single channel
- `0x8D board 0x01 0x00/0x01` -> disable / enable auto-upload on close
- `0x9A board channel 0x33` -> normally open
- `0x9B board channel 0x33` -> close
- `0x9D board 0x01 0x33` -> one-click sequential full open
- `0x7E board channel seconds` -> set unlock timeout

Important correction versus the first test build:

- The first test app used `0x8A ... 0x11` for unlock.
- The 2025 manual shows `0x8A ... 0x33` as the default unlock payload.
- The new UI keeps a fallback `Legacy 0x11` protocol profile for comparison in case the board firmware still expects the older frame.

## Android sample notes extracted from the document

The Android sample code in the document reinforces these points:

- `cmdSub` defaults to `0x33` unless a command explicitly says otherwise.
- Single-channel status responses use `0x00` for closed and `0x11` for open.
- Multi-channel reads return packed bits where channel 1 is the least-significant bit.
- `0` in the packed bitfield means open.
- `1` means closed or no feedback signal.

Field behavior and the manual conflict on the single-channel bytes. The
installed controller was previously observed returning `0x00` while open and
`0x11` while closed, the inverse of the Android sample. The app therefore has
two explicit profiles:

- `zeroOpen`: `0x00` open and `0x11` closed; current field default.
- `zeroClosed`: `0x00` closed and `0x11` open; manual/sample profile.

Do not choose a profile from documentation alone. During commissioning, read
one channel while closed, open it, read it again, close it and read it a third
time. Operations fail closed unless the app observes all three individual
readings with valid checksums and different open/closed bytes.

## Practical app direction

The front-end should therefore prioritize:

1. Reading all channels to build a live cabinet map.
2. Selecting a single door and opening or closing it.
3. Running an "identify door" action that opens the selected channel.
4. Supporting "normally open" and "open all" maintenance flows.
5. Showing a serial terminal for troubleshooting during commissioning.

## Source confidence

- High confidence: the supplied Word manual and on-device screenshots.
- Low confidence: public web information for this exact KS1062 management app was sparse and did not provide a reliable official reference for the stock software.
