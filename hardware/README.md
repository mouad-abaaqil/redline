# Hardware: board RL-MB-01

**Status: design with sourced parts. The PCB is not routed, nothing is built or measured.**

[`netlist.json`](./netlist.json) is the single source: 23 components with a size, a source or an "indicative" mark, 33 nets, rails with their ranges, buses, the one cable, and the hold-up assumptions. The drawings in [`../cad/`](../cad/README.md) are generated from it.

## What changed from TiltAlert

TiltAlert V1 is an Arduino Uno with a tilt contact. Its V2 study used a tracker with GNSS and LTE-M. Redline keeps that core (nRF9151, ADXL372, ADXL367, nPM1300, black box flash) and adds what the new product needs: a **hold-up capacitor** (U7, C1) for the last gasp, a **tamper mechanism** (TS1 with a spring plunger PL1 through the floor), the **DECT NR+ and NTN** layers (same SiP, no new chip), and an enclosure sized for it.

## Parts and sources

| Ref | Part | Source |
| --- | --- | --- |
| U1 | Nordic nRF9151 | https://www.nordicsemi.com/products/nrf9151 |
| U2 | Analog Devices ADXL372 | https://www.analog.com/en/products/adxl372.html |
| U3 | Analog Devices ADXL367 | https://www.analog.com/en/products/adxl367.html |
| U4 | Nordic nPM1300 | https://www.nordicsemi.com/Products/nPM1300 |
| U5 | Macronix MX25R6435F | https://www.mouser.fr/new/macronix/macronix-mx25r-nor-flash |
| ANT1 | Ignion NN02-224 | https://www.digikey.ph/en/products/detail/ignion/NN02-224/10108260 |
| ANT2 | Taoglas CGGBP.18.4.A.02 | https://www.taoglas.com/product/cggbp-18-4-a-02-gpsglonassbeidou-patch-antenna-18mm-2 |
| BT1 | Adafruit 2011 (3.7 V, 2000 mAh) | https://www.adafruit.com/product/2011 |

Parts marked "to choose" (USB-C, eSIM, connectors, button, LED, light pipe, hold-up charger, capacitor, tamper switch and plunger) have indicative envelopes only.

## Points to settle before routing

1. **Satellite antenna.** The chip antenna covers 824-960 and 1710-2690 MHz. NB-NTN uses L-band near 1.6 GHz, which is not covered. If the satellite layer is enabled it needs its own antenna and a coexistence plan with the GNSS patch.
2. **Hold-up.** The 0.5 F value and the energy unit are assumptions. Measure the capacitor ESR against the LTE-M burst current, and the real energy of a last-gasp message on each channel.
3. **Sequencing.** VDD_GPIO (1.8 V) must rise more than 6 ms after VDD and ENABLE: program BUCK1 of the nPM1300 accordingly.
4. **I²C addresses** of the ADXL367 (0x1D planned) and nPM1300 (0x6B planned) to confirm on the data sheets.
5. **GPIO assignment** of the nRF9151 (CS0, CS1, INT1-3, BTN, TAMPER, PWRFAIL, COEX0) to fix at routing.
6. **Black box readout.** The nRF9151 has no native USB, so the board has no USB data. Read the flash through the programming pads after recovery, or upload it over LTE-M. A USB bridge could be added.
7. **Tamper.** The plunger and spring, their travel and the mounting plate need a mechanical design and a test. A thief can defeat a switch with the right tool: treat it as one signal among several.
8. **Antenna tuning** with the battery in place and the lid on; the lid must stay non-metallic.
9. **Lithium cells** in air transport are regulated: check the rules for the chosen cell and quantity.
10. **Supply margin.** VSYS on battery falls to 3.0 V at cutoff, exactly the minimum of the nRF9151 VDD. There is no margin for sag during a transmit burst: measure it, and stop earlier with a software threshold if needed.

## Validation order

1. Firmware on a Nordic Thingy:91 X: core logic, black box, LTE-M reporting.
2. Route the PCB on four layers, then an RF review.
3. Bring up: rails, sequencing, SWD, sensor reads, flash.
4. Calibrated shocks, tilts and false-positive tests with the board fixed in the enclosure.
5. GNSS quality outdoors and in a vehicle, then recording with no network.
6. Hold-up and last-gasp test, fleet relay range test with two or three devices.
7. Autonomy, charge and temperature tests before any claim.
