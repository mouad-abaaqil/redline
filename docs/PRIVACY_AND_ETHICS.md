# Privacy and ethics

Redline tracks **cargo**. Position data attached to a vehicle is also, indirectly, data about the person driving it. In the European Union that falls under the GDPR and under employment law, and the rules differ by country. This file is a design stance, not legal advice.

## Rules the design follows

1. **The unit of tracking is the shipment.** The device is registered to a shipment, not to a driver. The demo data contains no driver identity.
2. **Track only while the cargo is on the move or armed.** Parked and disarmed at a depot, the device reduces its reporting. The route corridor and stops exist to protect the cargo, not to measure a person's behaviour.
3. **The driver is told.** A truck carrying a tracker is a workplace fact; drivers and their representatives must be informed. Rest-stop zones are authorized so that a legal break is never an alert.
4. **No performance scoring.** The break rule in the ETA engine exists to make the estimate honest about regulated rest. Nothing computes a driver's speed ranking, idle time, or stops for evaluation.
5. **Minimise and expire.** The black box and the platform keep what an incident needs. Retention periods must be set by the operator and the black box readout should be a controlled action.
6. **Open and auditable.** The detection logic is public so anyone can check what a device flags and why.

## What Redline deliberately does not do

- It does not identify or follow individuals, and has no map of where a person lives or goes outside the shipment.
- It does not hide itself from the person carrying the cargo by default (the status light can be disabled by the operator, which must be disclosed to the people concerned).
- It does not claim to detect theft with certainty. Jamming detection and the risk score are aids that can be wrong. An alert is a reason to look, not proof.

## Misuse

A tracker that survives removal and reports in secret is also a stalking tool when put on a person's belongings. The same properties that protect freight are dangerous in that use. The project is documented and licensed for freight. Hardware sold as a product would need anti-stalking measures such as alerting the people near an unknown moving tracker, and that is not designed here.
