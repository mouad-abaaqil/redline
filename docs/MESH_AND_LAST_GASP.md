# Fleet relay and last gasp

## The idea

Apple's Find My works because many devices carry a message that none of them can read. Redline applies the same principle to freight, with an operator-owned fleet instead of a consumer network: **any Redline device that is in range can carry another device's urgent message to the platform.**

## Layers

1. **Cellular (LTE-M / NB-IoT).** Normal reporting. Cheapest in energy per message.
2. **Fleet relay.** The [nRF9151](https://www.nordicsemi.com/products/nrf9151) supports DECT NR+, a mesh radio that needs no operator. A device with no link hands its message to a peer that has one. Messages carry a TTL (6 hops maximum), a priority, and an id so a message already seen is dropped.
3. **Satellite (NB-NTN).** Optional, off by default. The nRF9151 supports it, and services exist in Europe through operators such as [Skylo](https://www.skylo.tech/newsroom/deutsche-telekom-murata-and-skylo-technologies-announce-satellites-nb-iot-ntn-early-adopter-program-for-europe), but it costs money and needs its own L-band antenna (the chip antenna chosen does not cover it).

Priority 3 messages (theft, tamper, power loss) leave first, on whichever layer is up.

## Security model (design intent, not implemented)

- Messages are signed and encrypted end to end between the device and the platform. A relay sees an opaque payload and a priority byte, nothing more.
- A relay never reveals its own position in the message.
- Every device is provisioned with a key at manufacture. A stolen device can be revoked platform-side.

Not designed yet: key management, replay protection across devices, abuse by a malicious node flooding priority 3. These are real problems to solve before this could ship.

## Last gasp

When the supply drops (`PWR_FAIL`) or a crash is detected (shock ≥ 150 g), the firmware spends a fixed energy budget on the best affordable channel.

| Channel | Relative cost | Attempts |
| --- | --- | --- |
| Cellular | 1.0 | 2 |
| Fleet relay | 0.4 | 2 |
| Satellite | 2.5 | 2 |

The budget is 3.0 units. Hold-up check in `hardware/netlist.json`: a 0.5 F capacitor from 5 V to 3.3 V stores 3.53 J; if 1 unit is 0.5 J the budget needs 1.5 J, a 2.4× margin. **Both the unit and the 0.5 F are assumptions.** What decides it in practice is the capacitor's ESR during an LTE-M burst, which must be measured.

## What the simulation shows

In the theft shipment cellular is down for the last hour. The device keeps queuing. Passing fleet trucks (assumed 2 km range) carry 80 of its reports, the delayed theft alert, the tamper alert and the last gasp. The platform separately raises *device silent* when reports stop in theft mode.

## Limits

- A fleet relay only helps where other devices are. A truck alone on a mountain road has no relay.
- DECT NR+ range and behaviour in a moving fleet are unmeasured.
- Relaying consumes energy on devices that are not in trouble. The relay policy (when to accept, how many hops) needs a battery budget.
