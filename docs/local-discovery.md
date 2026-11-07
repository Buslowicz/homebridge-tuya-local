# Automatic local discovery

The plugin listens for Tuya announcements on UDP ports 6666, 6667 and 7000. Once the port 7000 listener is ready, it sends an authenticated Tuya discovery request (`REQ_DEVINFO`, command `0x25`) to the directed broadcast address of each non-internal IPv4 interface. It repeats these requests every 60 seconds while Homebridge is running.

The request format follows [TinyTuya's discovery implementation](https://github.com/jasonacox/tinytuya/blob/master/tinytuya/scanner.py) and its [command definitions](https://github.com/jasonacox/tinytuya/blob/master/tinytuya/core/command_types.py). No new dependency or cloud account is needed for scanning.

## Adding a device

Discovery runs even when the `devices` array is empty. When a new device responds, the Homebridge log shows its device ID, current IPv4 address and protocol version, with an instruction to configure it. This first version has no separate results panel or manual scan button.

To connect a device, add its ID, local key and supported device type to the plugin configuration. The local key must be 16 bytes. Discovery cannot obtain this secret or reliably select the device's HomeKit type. Devices marked disabled are ignored.

The IP address is optional. For configured devices, the plugin connects when discovery finds them. If no announcement arrives within 60 seconds, it uses a configured IPv4 address as a fallback. When discovery later finds a different IP, the existing connection is closed and reopened at the new address. The same HomeKit accessory is retained, and duplicate announcements do not create another connection.

Address changes are kept in memory; the plugin does not rewrite `config.json`. It discovers the address again after the next restart. Local keys and device types always come from configuration, never from a network announcement.

## Network and validation limits

Broadcast discovery normally requires the Homebridge host and device to share a network segment. VLAN boundaries, Wi-Fi client isolation, firewalls, containers or occupied UDP ports can prevent discovery. A fallback IP remains useful in those setups. The plugin sends discovery broadcasts, not a connection probe to every IP address.

Network messages are size-checked, parsed and reduced to device ID, source-matching IPv4 address and protocol version. Malformed messages and raw payloads are not printed. The discovery protocol uses a publicly known protocol key, so an announcement is not proof of device identity; the configured local key is still required for the control connection.

Automated tests cover real loopback UDP requests and replies, protocol compatibility, malformed and tampered packets, interface broadcasts, lifecycle cleanup, duplicate announcements and IP changes. Real TCP tests verify socket replacement and shutdown. These tests do not establish discovery behavior on every physical device or network. This feature has not been deployed to the existing Homebridge installation.
