# The signage OS image

An immutable x86_64 OS for a mini PC that is a SignForge screen. It is a Fedora bootc 44 image: it boots into cage and Chromium in kiosk mode, updates A/B in a nightly window, rolls back by itself when a new deployment is unhealthy, and installs unattended from a USB stick.

It is not the Pi kit (`device/pi`). The Pi serves the player on the device and plays offline-first, with the device supervisor beside it. This image opens a remote page, the CMS's browser test screen, and pairs as a browser screen. It has no supervisor, so it has no display-power schedule, no watchdog and no signed player builds yet.

Fedora 44 has no `mesa-va-drivers`: its VA drivers are in `mesa-dri-drivers`, and the image adds RPM Fusion's `mesa-va-drivers-freeworld` for the codecs Fedora leaves out, and `intel-media-driver` from RPM Fusion nonfree.

The first target is the MeLE PCG02 Pro stick (Celeron N5105, 8 GB, 128 GB eMMC). Its graphics decode H.264, HEVC and VP9 in hardware and not AV1, so give it no AV1 video. Nothing here has run on one yet: the image has been booted in a VM only (see [Testing in a VM](#testing-in-a-vm)), and 4K60 on the stick is still to be measured.

## Files

Everything under `rootfs/` is copied into the image at the same path.

```
device/bootc/
  Containerfile          the image
  config.toml            the installer's kickstart (build-iso.sh fills in the SSH key, time zone and Wi-Fi)
  build-iso.sh           builds the USB installer
  rootfs/
    etc/signage/config.env                                       KIOSK_URL and CHROMIUM_EXTRA_FLAGS
    etc/pam.d/signforge-kiosk                                    the kiosk's session: a logind seat, no login stack
    etc/greenboot/check/required.d/50-signforge-kiosk.sh         the health check
    etc/ssh/sshd_config.d/10-signforge.conf                      keys only
    usr/lib/systemd/system/signforge-kiosk.service               cage + Chromium on tty1
    usr/lib/systemd/system/bootc-fetch-apply-updates.timer.d/    the update window
    usr/lib/sysusers.d/signforge-kiosk.conf                      the kiosk user, UID 1000
    usr/lib/tmpfiles.d/signforge-kiosk.conf                      its home, /var/home/kiosk
    usr/lib/bootc/kargs.d/10-signforge.toml                      consoleblank=0
```

`.github/workflows/device-os.yml` builds and publishes it (docs/ci.md, "Device OS image").

## Building it

```sh
podman build --build-arg KIOSK_URL='https://<cms-host>/test-screen/?kind=browser&content=/v1/device' \
  -t signforge-os:dev -f device/bootc/Containerfile device/bootc
```

The build ends with `bootc container lint`. On an arm64 Mac, where Docker runs x86_64 under emulation, that step fails with "Function not implemented": build on x86_64 Linux, as CI does. Without `KIOSK_URL` the image opens a placeholder, `https://player.example.com/pair`. CI builds with the repository variable `SIGNFORGE_KIOSK_URL` when it is set.

## The URL and the pairing

Set `KIOSK_URL` to the CMS's browser test screen:

```
https://<cms-host>/test-screen/?kind=browser&content=/v1/device
```

It shows a pairing code; claim it in the CMS as any screen. Put no secret in the URL: a template frame can read its parent's address. The player keeps its credential in IndexedDB, in Chromium's profile under `/var/home/kiosk`. bootc never replaces `/var`, on an update or a rollback, so the screen stays paired. The kiosk user has a fixed UID (1000) so the profile keeps its owner across deployments.

To change the URL on one device, over SSH as root:

```sh
vi /etc/signage/config.env      # the KIOSK_URL line at the end
systemctl restart signforge-kiosk
```

`/etc` is kept across updates, with local edits merged.

## The update window

`bootc-fetch-apply-updates.timer` runs `bootc upgrade --apply`, which reboots into a new deployment when there is one. The image replaces the stock schedule (an hour after boot, then every 8 hours) with 03:00 local time, give or take 30 minutes. A screen that was off at 03:00 does not catch up when it is switched on: it waits for the next night.

To move the window on a device, add a higher-numbered drop-in, `/etc/systemd/system/bootc-fetch-apply-updates.timer.d/20-window.conf`:

```ini
[Timer]
OnCalendar=
OnCalendar=*-*-* 05:30:00
```

then `systemctl daemon-reload`. The window is local time, so set the zone too: `timedatectl set-timezone Europe/London`. The installer sets it from `TIMEZONE`.

## Health check and rollback

greenboot runs `50-signforge-kiosk.sh` on each boot. It judges a deployment once, on its first boots after an update. It fails when:
- the network is not up within 60 s (`nm-online`, over Ethernet or Wi-Fi);
- `signforge-kiosk.service` is not active within 120 s;
- the kiosk restarts or stops in the 15 s after that. Chromium exiting takes cage with it, and a crash loop reads as active between restarts.

A failure reboots. After 3 more failed boots (`GREENBOOT_MAX_BOOT_ATTEMPTS` in `/etc/greenboot/greenboot.conf`) grub boots the previous deployment, and greenboot makes that the default. In a VM a broken kiosk was back on the previous deployment about two minutes after the update's reboot.

A deployment that passes is written to `/var/lib/signforge/proven-deployments` and is not checked again; nor is one with no other deployment to go back to, as on a new install. greenboot reboots on a failed check on any boot, update or not, so without this a screen switched on while its network is down would reboot every minute and then fall back to an older OS.

An update applied while the site's network is down fails the check and rolls back. The device stays on its tag, so the timer tries the same image again the next night, and a broken image on that tag costs those reboots every night until a good one is pushed.

- `bootc status` shows the booted, staged and rollback deployments.
- `bootc rollback`, then a reboot, goes back by hand.
- `journalctl -u greenboot-healthcheck` shows what the check said.

## Channels

CI pushes every build to `ghcr.io/alexrobinett/signforge-os:canary` and promotes a tested one to `:stable`. Move a device between them with:

```sh
sudo bootc switch ghcr.io/alexrobinett/signforge-os:canary   # or :stable
```

then reboot, or add `--apply` to reboot at once. The nightly timer follows whichever tag the device is on.

The GHCR package must be public, or each device needs a pull secret in `/etc/ostree/auth.json` (a `podman login` auth file).

## The USB installer

**The installer erases every disk in the machine it boots on, without asking.** Keep it away from any computer that is not about to become a screen.

On a Linux machine with podman:

```sh
SSH_PUBKEY_FILE=~/.ssh/id_ed25519.pub TIMEZONE=America/New_York \
  WIFI_SSID='Shop Floor' WIFI_PSK='…' ./device/bootc/build-iso.sh [image]
```

The image defaults to `ghcr.io/alexrobinett/signforge-os:stable`; `SSH_PUBKEY_FILE` to `~/.ssh/id_ed25519.pub` and `TIMEZONE` to `UTC`. `WIFI_SSID` and `WIFI_PSK` are optional; see [Wi-Fi](#wi-fi). It prints the ISO's path, `device/bootc/output/bootiso/install.iso`. Write it to a stick:

```sh
sudo dd if=device/bootc/output/bootiso/install.iso of=/dev/sdX bs=4M status=progress oflag=sync
```

The machine boots it, partitions the disk (GPT, XFS, no swap), installs the image, locks root's password, puts the key in root's `authorized_keys`, and reboots into the kiosk. SSH in as root with that key. The install itself needs no network: the image is on the stick.

## Wi-Fi

The image has NetworkManager's Wi-Fi support and Intel's Wi-Fi firmware beside the Realtek, MediaTek, Atheros and Broadcom firmware of the base image. A wired port needs nothing: NetworkManager runs DHCP on it.

With `WIFI_SSID` and `WIFI_PSK` set, `build-iso.sh` has the installer write a WPA profile to `/etc/NetworkManager/system-connections/signforge-wifi.nmconnection` (root only), and the screen joins that network on its first boot. **That ISO holds the network's password in plain text**, as does the device: treat the stick as the password. The image on GHCR never holds it. Neither value can contain a backslash, a double quote or a newline. The profile has not been tried on a device yet.

To set Wi-Fi up without putting the password on the stick, install over Ethernet and run `nmcli device wifi connect '<ssid>' password '<password>'` over SSH.

## Testing in a VM

With QEMU/KVM and OVMF on Linux. Build a disk image with the same builder:

```sh
sudo podman run --rm --privileged --pull=newer --security-opt label=type:unconfined_t \
  -v ./vm.toml:/config.toml:ro -v ./output:/output -v /var/lib/containers/storage:/var/lib/containers/storage \
  quay.io/centos-bootc/bootc-image-builder:latest --type qcow2 --rootfs xfs <image>
```

`vm.toml` gives a login, for example a `[[customizations.user]]` with `name = "root"` and your `key`. Boot it:

```sh
qemu-system-x86_64 -enable-kvm -machine q35 -cpu host -m 4G -bios /usr/share/edk2/ovmf/OVMF_CODE.fd \
  -device virtio-vga-gl -display gtk,gl=on \
  -drive file=output/qcow2/disk.qcow2,if=virtio \
  -nic user,model=virtio-net-pci,hostfwd=tcp::2222-:22
```

To try the installer, make a blank disk (`qemu-img create -f qcow2 blank.qcow2 40G`) and boot the ISO with it (`-drive file=blank.qcow2,if=virtio -cdrom output/bootiso/install.iso`).

To prove rollback, build an image whose kiosk is broken (an `ExecStart` that exits, say), push it, and on the VM `bootc switch --apply` to it. Each boot fails the check and reboots; after the fourth, grub boots the previous deployment and `bootc status` shows it booted.

## Checking video decode

A VM has no Intel iGPU, so this needs real hardware. Over SSH as root:

```sh
vainfo --display drm --device /dev/dri/renderD128
```

It should list `VAEntrypointVLD` for H.264, HEVC and VP9 (and AV1 on newer Intel graphics than the N5105's). Then, in Chromium:
1. Add `--remote-debugging-port=9222` to `CHROMIUM_EXTRA_FLAGS` and restart the kiosk.
2. Forward the port: `ssh -L 9222:127.0.0.1:9222 root@<device>`, and open `http://localhost:9222` in a local Chromium.
3. `chrome://gpu` should say "Video Decode: Hardware accelerated".
4. Play a 4K60 clip; `chrome://media-internals` should show `VaapiVideoDecoder` for it.

Take the flag out again afterwards.
