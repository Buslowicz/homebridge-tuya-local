# Homebridge 2 / Tuya 3.5 compatibility

Based on `morfeldt/homebridge-tuya-local` commit `9db4f6957be8ee33ebd052abaa9054ee5fe2c4ba`.

## Changes

- Read accessory categories and characteristic permissions from the HAP exports supplied by Homebridge 2.
- Keep custom energy characteristics in a platform-owned HAP object. Never assign properties to Homebridge's module namespace. Energy characteristic UUIDs and their read/notify behavior remain available to outlet accessories.
- Frame TCP input using declared packet lengths. Keep partial headers between chunks, process multiple packets in one chunk, and avoid treating a footer-like sequence inside encrypted data as the end of a packet.
- Exercise startup, cached heater restoration, unreachable signaling, energy characteristics and packet framing in regression tests. Tests use synthetic data and local loopback connections; no device credentials are required.

## Validation and limits

The initial compatibility changes were checked against a real Tuya 3.5 heater with Homebridge 2.5.0 / HAP 2.3.0. Homebridge connected to the device, read its state, and displayed the heater after restoring its cached accessory. This hardware check covered the locally patched installation; this fork's subsequent generalized framing and energy fixes are covered by automated tests and have not been installed on that device.

The project has no application build or lint step. `npm run check` checks JavaScript syntax, and `npm test` runs the regression suite. CI runs those commands on Node 22, 24 and 26. A local pass on one Node version does not establish that all CI jobs passed.

An initial `npm audit` reported five inherited vulnerable dependency nodes (three moderate, two high): `http-mitm-proxy`, `uuid`, `node-forge`, `ws`, and `yaml`. This compatibility patch does not claim to remediate those advisories. The credential-discovery / interception CLI tools are outside the tested behavior. Audit results are informational for this bounded patch, not a passing security certification.

No npm package is published by this fork's workflow. No Homebridge configuration, device IDs, local keys, or device logs belong in this repository.
