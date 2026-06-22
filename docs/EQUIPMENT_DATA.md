# Clara AI — Fire Protection Pricebook

The data source behind the **Estimate Cost** copilot. The agent matches what a
technician describes/photographs against these tables to build a line-item
quotation. Prices are list prices in **USD**.

> The runtime copy used by the estimate engine lives in
> [`src/copilot/estimate/estimatePricebook.ts`](../src/copilot/estimate/estimatePricebook.ts)
> (the Docker image ships `src/`, not `docs/`). **Keep the two in sync** — update
> both when prices/parts change.

**Sheets**
1. [Materials — Sprinkler Systems](#1-materials--sprinkler-systems)
2. [Materials — Fire Alarm Systems](#2-materials--fire-alarm-systems)
3. [Materials — Fire Extinguishers & Suppression](#3-materials--fire-extinguishers--suppression)
4. [Labor Rates](#4-labor-rates)
5. [Standard Services (NFPA inspections/testing/maintenance)](#5-standard-services)
6. [Quotation Format](#6-quotation-format)
7. [Labor Benchmarks (AI estimation)](#7-labor-benchmarks)

---

## 1. Materials — Sprinkler Systems

### Sprinkler Heads — Upright (SSU)
| Item # | Model | Description | Mfr | Unit | Unit Cost |
|---|---|---|---|---|---|
| SP-001 | TY3251 | 1/2" NPT Upright 155°F Standard Response K=5.6 (light hazard) | Tyco | EA | $5.25 |
| SP-002 | TY1251 | 1/2" NPT Upright 175°F Standard Response K=5.6 (ordinary hazard) | Tyco | EA | $5.25 |
| SP-003 | TY5151 | 1/2" NPT Upright 165°F Quick Response K=5.6 | Tyco | EA | $6.80 |
| SP-004 | F1FR-34 | 3/4" NPT Upright 155°F Standard Response K=8.0 (intermediate) | Viking | EA | $7.40 |
| SP-005 | G5A8 | 1/2" NPT Upright 200°F Extra-High-Temp K=5.6 (high heat) | Victaulic | EA | $5.90 |

### Sprinkler Heads — Pendant (SSP)
| Item # | Model | Description | Mfr | Unit | Unit Cost |
|---|---|---|---|---|---|
| SP-010 | TY3151 | 1/2" NPT Pendant 155°F Standard Response K=5.6 | Tyco | EA | $5.25 |
| SP-011 | TY1151 | 1/2" NPT Pendant 175°F Standard Response K=5.6 | Tyco | EA | $5.25 |
| SP-012 | TY4151 | 1/2" NPT Pendant 155°F Quick Response K=5.6 | Tyco | EA | $6.80 |
| SP-013 | G5A5 | 3/4" NPT Pendant 155°F K=8.0 Standard Response | Victaulic | EA | $7.20 |

### Sprinkler Heads — Concealed (SSC)
| Item # | Model | Description | Mfr | Unit | Unit Cost |
|---|---|---|---|---|---|
| SP-020 | TY2934 | 1/2" Concealed Pendant 135/165°F QR K=5.6 White (incl. cover plate) | Tyco | EA | $14.50 |
| SP-021 | TY2936 | 1/2" Concealed Pendant 155/165°F QR K=5.6 Chrome | Tyco | EA | $14.50 |
| SP-022 | VC-1 | Concealed Pendant 135/175°F K=5.6 White | Viking | EA | $16.20 |
| SP-023 | EC-1 | Concealed Pendant Cover Plate (replacement only) White | ESCO | EA | $4.80 |

### Sprinkler Heads — Sidewall (SSW)
| Item # | Model | Description | Mfr | Unit | Unit Cost |
|---|---|---|---|---|---|
| SP-030 | TY1131 | 1/2" Extended Coverage Sidewall 155°F K=5.6 (hotels, corridors) | Tyco | EA | $7.90 |
| SP-031 | F1FR-SW | 1/2" Standard Sidewall 155°F K=5.6 | Viking | EA | $6.50 |

### Pipe & Fittings — Black Steel Schedule 40
| Item # | Model | Description | Unit | Unit Cost |
|---|---|---|---|---|
| PP-001 | BS-1.0-10 | Black Steel Sch 40 Pipe 1" — per 10ft | EA | $12.50 |
| PP-002 | BS-1.25-10 | Black Steel Sch 40 Pipe 1-1/4" — per 10ft | EA | $16.80 |
| PP-003 | BS-1.5-10 | Black Steel Sch 40 Pipe 1-1/2" — per 10ft | EA | $21.00 |
| PP-004 | BS-2.0-10 | Black Steel Sch 40 Pipe 2" — per 10ft | EA | $28.50 |
| PP-005 | BS-2.5-10 | Black Steel Sch 40 Pipe 2-1/2" — per 10ft | EA | $38.00 |
| PP-006 | BS-3.0-10 | Black Steel Sch 40 Pipe 3" — per 10ft | EA | $52.00 |
| PP-007 | BS-4.0-10 | Black Steel Sch 40 Pipe 4" — per 10ft (main headers) | EA | $78.00 |
| PP-010 | ELB-1.0-90 | 1" 90° Elbow Threaded | EA | $1.80 |
| PP-011 | ELB-1.5-90 | 1-1/2" 90° Elbow Threaded | EA | $3.20 |
| PP-012 | ELB-2.0-90 | 2" 90° Elbow Threaded | EA | $4.80 |
| PP-013 | TEE-1.0 | 1" Tee Threaded | EA | $2.40 |
| PP-014 | TEE-1.5 | 1-1/2" Tee Threaded | EA | $4.10 |
| PP-015 | TEE-2.0 | 2" Tee Threaded | EA | $6.20 |
| PP-016 | COUP-2.0 | Victaulic 2" Groove Coupling Style 77 | EA | $8.50 |
| PP-017 | COUP-3.0 | Victaulic 3" Groove Coupling Style 77 | EA | $14.20 |
| PP-018 | COUP-4.0 | Victaulic 4" Groove Coupling Style 77 | EA | $21.50 |

### Pipe & Fittings — CPVC (residential / light commercial)
| Item # | Model | Description | Mfr | Unit | Unit Cost |
|---|---|---|---|---|---|
| PP-030 | CPVC-3/4-10 | BlazeMaster CPVC 3/4" Pipe — per 10ft | Lubrizol | EA | $9.20 |
| PP-031 | CPVC-1.0-10 | BlazeMaster CPVC 1" Pipe — per 10ft | Lubrizol | EA | $12.80 |
| PP-032 | CPVC-ELB-1 | BlazeMaster CPVC 1" 90° Elbow | Lubrizol | EA | $1.50 |
| PP-033 | CPVC-TEE-1 | BlazeMaster CPVC 1" Tee | Lubrizol | EA | $1.90 |

### Valves
| Item # | Model | Description | Mfr | Unit | Unit Cost |
|---|---|---|---|---|---|
| VL-001 | OSY-2.5 | OS&Y Gate Valve 2-1/2" Flanged Iron Body | Nibco | EA | $185.00 |
| VL-002 | OSY-3.0 | OS&Y Gate Valve 3" Flanged Iron Body | Nibco | EA | $220.00 |
| VL-003 | OSY-4.0 | OS&Y Gate Valve 4" Flanged Iron Body | Nibco | EA | $310.00 |
| VL-004 | BFV-3.0 | Butterfly Valve 3" Grooved Lug, Supervised (w/ tamper) | Victaulic | EA | $142.00 |
| VL-005 | BFV-4.0 | Butterfly Valve 4" Grooved Lug, Supervised | Victaulic | EA | $195.00 |
| VL-006 | CV-2.0 | Check Valve 2" Swing Threaded 175psi | Watts | EA | $52.00 |
| VL-007 | CV-3.0 | Check Valve 3" Flanged Wafer | Watts | EA | $98.00 |
| VL-008 | DRV-4.0 | Dry Pipe Valve Assembly 4" 175psi (complete) | Viking | EA | $1,450.00 |
| VL-009 | DP-TRIM-4 | Dry Pipe Valve Trim Package 4" | Viking | EA | $380.00 |
| VL-010 | WET-TRIM-4 | Wet Alarm Valve Trim Package 4" (incl. retard chamber) | Viking | EA | $520.00 |
| VL-011 | DELUGE-4 | Deluge Valve Assembly 4" 175psi | Viking | EA | $1,680.00 |
| VL-012 | PRV-1.0 | Pressure Reducing Valve 1" Adjustable 25–75psi | Watts | EA | $88.00 |

### Flow Devices, Alarms & Monitoring
| Item # | Model | Description | Mfr | Unit | Unit Cost |
|---|---|---|---|---|---|
| FD-001 | FS-1.5 | Flow Switch Saddle 1-1/2" SPDT (vane) | Potter | EA | $48.00 |
| FD-002 | FS-2.0 | Flow Switch Saddle 2" SPDT | Potter | EA | $52.00 |
| FD-003 | FS-4.0 | Flow Switch Saddle 4" SPDT | Potter | EA | $62.00 |
| FD-004 | TS-OSY | Tamper Switch for OS&Y Valve | Potter | EA | $38.00 |
| FD-005 | TS-BFV | Tamper Switch for Butterfly Valve | Potter | EA | $42.00 |
| FD-006 | WM-100 | Water Motor Alarm Bell Assembly 4" (outdoor) | Viking | EA | $95.00 |
| FD-007 | ELEC-BELL | Electric Alarm Bell 8" 120V | Edwards | EA | $45.00 |
| FD-008 | PG-160 | Pressure Gauge 0-160psi 2-1/2" Dial | Ashcroft | EA | $14.50 |
| FD-009 | PG-300 | Pressure Gauge 0-300psi 2-1/2" Dial | Ashcroft | EA | $16.00 |

### Hangers & Supports
| Item # | Model | Description | Mfr | Unit | Unit Cost |
|---|---|---|---|---|---|
| HG-001 | ARM-1 | Hanger Arm w/ Loop 1" | AFAC | EA | $2.20 |
| HG-002 | ARM-2 | Hanger Arm w/ Loop 2" | AFAC | EA | $3.40 |
| HG-003 | BS-ROD-10 | Threaded Hanger Rod 1/2" × 10ft | Generic | EA | $6.80 |
| HG-004 | SS-CLAMP-2 | Seismic Sway Brace Clamp 2" (seismic zones) | AFAC | EA | $12.50 |
| HG-005 | OFFSET-1 | Offset Hanger 1" UL Listed | AFAC | EA | $3.80 |

---

## 2. Materials — Fire Alarm Systems

### Fire Alarm Control Panels (FACP)
| Item # | Model | Description | Mfr | Unit | Unit Cost |
|---|---|---|---|---|---|
| FA-001 | MS-5UD-3S | Notifier MS-5 3-zone Addressable Panel (≤99 pts/loop) | Notifier | EA | $420.00 |
| FA-002 | NFS2-640 | Notifier NFS2-640 Addressable FACP (≤636 pts) | Notifier | EA | $2,150.00 |
| FA-003 | EST3 | Edwards EST3 Modular FACP — base chassis only | Edwards | EA | $3,200.00 |
| FA-004 | FARENHYT-2 | Siemens FACP 2-loop Addressable | Siemens | EA | $1,850.00 |
| FA-005 | 1100X | Napco Gemini 1100X Commercial Panel 8-zone | Napco | EA | $380.00 |
| FA-006 | RZI-5 | Remote Annunciator 5-zone LED (ADA locations) | Various | EA | $145.00 |
| FA-007 | LCD-80F | LCD Annunciator 80-char display | Notifier | EA | $320.00 |

### Smoke Detectors
| Item # | Model | Description | Mfr | Unit | Unit Cost |
|---|---|---|---|---|---|
| FA-010 | FSP-951 | Addressable Photo Smoke Detector (SLC loop) | Notifier | EA | $52.00 |
| FA-011 | DNRX-P | Photo/Heat Combo Addressable | System Sensor | EA | $68.00 |
| FA-012 | D4120 | Duct Smoke Detector w/ housing (HVAC) | System Sensor | EA | $185.00 |
| FA-013 | B501BH | Standard Detector Base 4" (universal) | System Sensor | EA | $8.50 |
| FA-014 | FSI-951 | Ionization Smoke Detector Addressable | Notifier | EA | $48.00 |
| FA-015 | BEAM1224 | Beam Smoke Detector — Projector (open areas >40ft) | System Sensor | EA | $620.00 |

### Heat Detectors
| Item # | Model | Description | Mfr | Unit | Unit Cost |
|---|---|---|---|---|---|
| FA-020 | 5600F | Fixed Temp 135°F Addressable | System Sensor | EA | $42.00 |
| FA-021 | 5600TF | Rate-of-Rise + Fixed Temp Addressable | System Sensor | EA | $48.00 |
| FA-022 | H365 | Low-profile Heat Detector Addressable | Notifier | EA | $38.00 |

### Manual Pull Stations
| Item # | Model | Description | Mfr | Unit | Unit Cost |
|---|---|---|---|---|---|
| FA-030 | NBG-12LX | Addressable Manual Pull, Single Action | Notifier | EA | $62.00 |
| FA-031 | BG-12L | Manual Pull, Non-Addressable Conventional | Notifier | EA | $28.00 |
| FA-032 | G1F-HDVM | Addressable Pull Station | Gamewell FCI | EA | $58.00 |

### Notification Appliances — Horns & Strobes
| Item # | Model | Description | Mfr | Unit | Unit Cost |
|---|---|---|---|---|---|
| FA-040 | P2RK | 2-wire Horn Strobe Red 110dB ANSI (ceiling) | System Sensor | EA | $48.00 |
| FA-041 | PC2RK | 2-wire Combo Horn Strobe (ceiling) | System Sensor | EA | $54.00 |
| FA-042 | SW2RK | Strobe-only Wall Mount Red | System Sensor | EA | $36.00 |
| FA-043 | SPSR24 | Speaker/Strobe 24V Combo (voice evac) | Wheelock | EA | $68.00 |
| FA-044 | MTH24-115 | Wall Horn Strobe 24V High Candela (ADA) | Wheelock | EA | $58.00 |

### Modules & Interfaces
| Item # | Model | Description | Mfr | Unit | Unit Cost |
|---|---|---|---|---|---|
| FA-050 | MMF-302 | Monitor Module Addressable Single Input | Notifier | EA | $42.00 |
| FA-051 | CMF-300 | Control Module — Addressable Output Relay | Notifier | EA | $48.00 |
| FA-052 | FCM-1 | Fan Control Module FACP interface | Notifier | EA | $68.00 |
| FA-053 | RM-1 | Relay Module DPDT 24V (isolation) | Various | EA | $32.00 |

### Wire, Cable & Conduit
| Item # | Model | Description | Mfr | Unit | Unit Cost |
|---|---|---|---|---|---|
| FA-060 | FPLR-16-2 | FPLR 16 AWG 2-cond. Fire Alarm Cable — per 1000ft (SLC) | Belden | RL | $148.00 |
| FA-061 | FPLR-14-2 | FPLR 14 AWG 2-cond. — per 1000ft (NAC/power) | Belden | RL | $190.00 |
| FA-062 | SHLD-16-2 | Shielded 16 AWG 2-cond. — per 1000ft (data bus) | Belden | RL | $198.00 |
| FA-063 | EMT-3/4 | EMT Conduit 3/4" — per 10ft | Allied | EA | $4.20 |
| FA-064 | EMT-1.0 | EMT Conduit 1" — per 10ft | Allied | EA | $6.10 |
| FA-065 | J-BOX-4SQ | 4" Square Metal Junction Box w/ cover | Raco | EA | $3.80 |

### Batteries & Power Supplies
| Item # | Model | Description | Mfr | Unit | Unit Cost |
|---|---|---|---|---|---|
| FA-070 | BAT-12V-12 | 12V 12AH Sealed Lead-Acid Battery (FACP standby) | Yuasa | EA | $28.00 |
| FA-071 | BAT-12V-18 | 12V 18AH Sealed Lead-Acid Battery | Yuasa | EA | $36.00 |
| FA-072 | PS-10E | Power Supply Expander 10A 24V (NAC) | Bosch | EA | $185.00 |
| FA-073 | BC-12V | Battery Charger/Booster for FACP | Various | EA | $48.00 |

### Monitoring & Communication
| Item # | Model | Description | Mfr | Unit | Unit Cost |
|---|---|---|---|---|---|
| FA-080 | DACT-2 | Digital Alarm Communicator Transmitter Dual-path | Napco | EA | $165.00 |
| FA-081 | IP-COM | IP/Cellular FACP Communicator Module | Various | EA | $220.00 |
| FA-082 | ANNEX-8 | Remote 8-zone LED Annunciator Panel (lobby) | Notifier | EA | $195.00 |

---

## 3. Materials — Fire Extinguishers & Suppression

### Portable Fire Extinguishers
| Item # | Model | Description | Mfr | Unit | Unit Cost |
|---|---|---|---|---|---|
| EX-001 | ABC-2.5 | 2.5 lb ABC Dry Chemical (w/ bracket) | Amerex | EA | $32.00 |
| EX-002 | ABC-5 | 5 lb ABC Dry Chemical | Amerex | EA | $42.00 |
| EX-003 | ABC-10 | 10 lb ABC Dry Chemical (most common commercial) | Amerex | EA | $58.00 |
| EX-004 | ABC-20 | 20 lb ABC Dry Chemical (warehouse/industrial) | Amerex | EA | $95.00 |
| EX-005 | CO2-5 | 5 lb CO2 w/ horn (server rooms, labs) | Amerex | EA | $72.00 |
| EX-006 | CO2-10 | 10 lb CO2 w/ horn | Amerex | EA | $98.00 |
| EX-007 | CO2-20 | 20 lb CO2 w/ horn | Amerex | EA | $158.00 |
| EX-008 | K-6 | 6 liter Class K Wet Chemical (commercial kitchens) | Amerex | EA | $135.00 |
| EX-009 | HALON-1211 | Halotron I 2.5 lb (aircraft/electronics, clean agent) | Amerex | EA | $88.00 |
| EX-010 | WALL-MT | Wall Bracket/Hanger — universal | Generic | EA | $6.50 |
| EX-011 | CABINET-STD | Recessed Steel Cabinet 10 lb (requires drywall cut) | JL Ind | EA | $68.00 |
| EX-012 | CABINET-SFC | Surface Mount Cabinet 10 lb (no cutting) | JL Ind | EA | $52.00 |

### Kitchen Hood Suppression — Ansul R-102 compatible
| Item # | Model | Description | Mfr | Unit | Unit Cost |
|---|---|---|---|---|---|
| KH-001 | R102-1.5 | Ansul R-102 1.5 Gallon Tank Assembly (≤6 nozzles) | Ansul | EA | $420.00 |
| KH-002 | R102-3.0 | Ansul R-102 3.0 Gallon Tank Assembly (larger hoods) | Ansul | EA | $680.00 |
| KH-003 | 423176 | Ansul Nozzle 1W (fryer) R-102 | Ansul | EA | $28.00 |
| KH-004 | 423177 | Ansul Nozzle 2W (griddle/wok) R-102 | Ansul | EA | $28.00 |
| KH-005 | 43702 | Ansul LPK Nozzle (plenum/duct) | Ansul | EA | $28.00 |
| KH-006 | 420075 | Ansul Fusible Link 360°F (replace annually) | Ansul | EA | $4.50 |
| KH-007 | FUEL-SHUT | Fuel Shutoff Valve Gas 3/4" (mechanical, code required) | Ansul | EA | $185.00 |
| KH-008 | PULL-CABLE | Manual Pull Station Cable & Actuator | Ansul | EA | $38.00 |
| KH-009 | MICRO-SWTH | Microswitch for Electric Fuel Shutoff | Ansul | EA | $42.00 |
| KH-010 | NOZZ-GUARD | Nozzle Guard / Blow-off Cap (replace each service) | Ansul | EA | $2.80 |
| KH-011 | CLEAN-AGENT | PYRO-CHEM Dry Chemical Cartridge 101 lb refill | Pyro-Chem | EA | $320.00 |

### Clean Agent & Special Hazard Suppression
| Item # | Model | Description | Mfr | Unit | Unit Cost |
|---|---|---|---|---|---|
| SH-001 | FK-5-1-12 | FM-200 (HFC-227ea) Agent Cylinder 50 lb (server/data center) | Kidde | EA | $1,850.00 |
| SH-002 | NOVEC-1230 | 3M Novec 1230 Agent Cylinder 50 lb | 3M | EA | $2,200.00 |
| SH-003 | INERGEN-50 | Inergen IG-541 Cylinder 50 lb | Ansul | EA | $1,400.00 |
| SH-004 | CO2-45 | CO2 Fixed Suppression Cylinder 45 lb | Kidde | EA | $580.00 |
| SH-005 | SOLENOID-24 | 24VDC Solenoid Valve for Agent Release | Various | EA | $125.00 |
| SH-006 | ABORT-SW | Abort Switch Manual Override | Various | EA | $88.00 |

### Fire Hose Stations & Standpipe
| Item # | Model | Description | Mfr | Unit | Unit Cost |
|---|---|---|---|---|---|
| HS-001 | CAB-2.5 | Fire Hose Cabinet 2.5" valve + 100ft hose (Class I) | JL Ind | EA | $420.00 |
| HS-002 | CAB-1.5 | Fire Hose Cabinet 1.5" valve + 75ft hose (Class II) | JL Ind | EA | $280.00 |
| HS-003 | HOSE-1.5-50 | 1.5" Lined Hose 50ft NST | Generic | EA | $95.00 |
| HS-004 | HOSE-2.5-50 | 2.5" Lined Hose 50ft NST | Generic | EA | $145.00 |
| HS-005 | FDC-2.5X2 | Fire Dept Connection Siamese 2.5"×2 w/ caps | Elkhart | EA | $185.00 |
| HS-006 | HYDRANT-4 | Wall Hydrant / Hose Bibb 3/4" Backflow Protected | Woodford | EA | $62.00 |

### Backflow Preventers
| Item # | Model | Description | Mfr | Unit | Unit Cost |
|---|---|---|---|---|---|
| BF-001 | DCVA-3/4 | Double Check Valve Assembly 3/4" Bronze (low hazard) | Watts | EA | $145.00 |
| BF-002 | DCVA-1.0 | Double Check Valve Assembly 1" Bronze | Watts | EA | $195.00 |
| BF-003 | DCVA-2.0 | Double Check Valve Assembly 2" Bronze | Watts | EA | $480.00 |
| BF-004 | RPZ-3/4 | Reduced Pressure Zone Backflow 3/4" (high hazard) | Watts | EA | $275.00 |
| BF-005 | RPZ-1.0 | Reduced Pressure Zone Backflow 1" | Watts | EA | $380.00 |
| BF-006 | RPZ-2.0 | Reduced Pressure Zone Backflow 2" | Watts | EA | $890.00 |
| BF-007 | RPZ-4.0 | Reduced Pressure Zone Backflow 4" | Watts | EA | $2,400.00 |

---

## 4. Labor Rates

### Field Technician Rates
| Rate Code | Role | Conditions | Unit | Rate |
|---|---|---|---|---|
| LB-001 | Tech I — Helper/Apprentice | 0–2 yrs. Assists, pulls wire, basic installs | HR | $55.00 |
| LB-002 | Tech II — Journeyman | 2–5 yrs. Independent installs, service calls (**default**) | HR | $75.00 |
| LB-003 | Tech III — Lead / NICET II | 5–10 yrs. Complex inspections | HR | $95.00 |
| LB-004 | Tech IV — Senior / NICET III | 10+ yrs. Design reviews, large jobs | HR | $115.00 |
| LB-005 | NICET IV / PE | Design, plan review, AHJ liaison | HR | $145.00 |
| LB-006 | Project Foreman | Supervision + labor, crew of 2–4 | HR | $105.00 |

### Time-Based Modifiers
| Rate Code | Type | Conditions | Unit | Rate |
|---|---|---|---|---|
| LB-010 | Overtime 1.5× | Hrs 41–52/week, or before 7am/after 5pm | HR | $112.50 |
| LB-011 | Double Time 2× | Hrs >52/week, Sundays, federal holidays | HR | $150.00 |
| LB-012 | Emergency / On-Call | After-hours/unscheduled (min 2 hr) | HR | $165.00 |
| LB-013 | Holiday Rate | Federal + state holidays (min 4 hr) | HR | $175.00 |

### Service Minimums & Travel
| Rate Code | Type | Conditions | Unit | Rate |
|---|---|---|---|---|
| LB-020 | Minimum Service Call | Min charge per dispatch (T&M) | CALL | $175.00 |
| LB-021 | Travel — In Zone (<30mi) | Round trip within primary zone | TRIP | $65.00 |
| LB-022 | Travel — Extended (30–75mi) | Round trip outside zone | TRIP | $145.00 |
| LB-023 | Travel — Out-of-Area (>75mi) | Long distance, same-day return | TRIP | $285.00 |
| LB-024 | Mileage | Per mile (alt. to flat trip fee) | MILE | $0.67 |
| LB-025 | Per Diem — Overnight | Lodging + meals | DAY | $195.00 |

### Equipment & Access Rentals
| Rate Code | Type | Conditions | Unit | Rate |
|---|---|---|---|---|
| LB-030 | Scissor Lift 19ft | Electric, flat concrete | DAY | $245.00 |
| LB-031 | Scissor Lift 26ft | Electric, higher ceilings | DAY | $320.00 |
| LB-032 | Boom Lift 40ft | Articulating, outdoor/rough terrain | DAY | $480.00 |
| LB-033 | Ladder Rental (tall) | Extension 40ft+ | DAY | $45.00 |
| LB-034 | Scaffolding Setup | Rental + setup labor | DAY | $380.00 |
| LB-035 | Pipe Threader Rental | Electric, field use | DAY | $85.00 |
| LB-036 | Hydrostatic Test Pump | 5-year standpipe/underground tests | DAY | $95.00 |

### Permits & Compliance (pass-through)
| Rate Code | Type | Conditions | Unit | Rate |
|---|---|---|---|---|
| LB-040 | Building Permit — Small | 1–5 devices/heads | EA | $185.00 |
| LB-041 | Building Permit — Medium | 6–50 devices | EA | $380.00 |
| LB-042 | Building Permit — Large | 51+ devices | EA | $750.00 |
| LB-043 | Plan Review Fee | AHJ plan review, per submission | EA | $225.00 |
| LB-044 | Inspection Fee — AHJ | City/county field inspection | EA | $150.00 |
| LB-045 | As-Built Drawings | Drafting record drawings (CAD) | HR | $110.00 |

---

## 5. Standard Services

NFPA inspections, testing & maintenance. List price and discounted contract price.

### Fire Sprinkler Inspections (NFPA 25)
| Svc Code | Service | Frequency | Hrs | List | Contract | NFPA |
|---|---|---|---|---|---|---|
| SV-001 | Sprinkler Inspection — Small (<50 heads) | Annual | 2.00 | $285 | $220 | NFPA 25 |
| SV-002 | Sprinkler Inspection — Medium (50–200) | Annual | 3.50 | $420 | $340 | NFPA 25 |
| SV-003 | Sprinkler Inspection — Large (201–500) | Annual | 5.00 | $620 | $495 | NFPA 25 |
| SV-004 | Sprinkler Inspection — XL (500+) | Annual | 8.00 | $950 | $760 | NFPA 25 |
| SV-005 | Sprinkler Quarterly — Wet | Quarterly | 0.50 | $75 | $60 | NFPA 25 5.2 |
| SV-006 | Sprinkler Weekly — Gauges | Weekly | 0.25 | $35 | $28 | NFPA 25 5.2.4 |
| SV-007 | Dry System Inspection | Annual | 4.50 | $560 | $450 | NFPA 25 7 |
| SV-008 | Deluge/Preaction Inspection | Annual | 5.50 | $680 | $545 | NFPA 25 8 |

### Sprinkler Testing (NFPA 25 — periodic)
| Svc Code | Service | Frequency | Hrs | List | Contract | NFPA |
|---|---|---|---|---|---|---|
| SV-020 | Main Drain Flow Test | Annual | 1.00 | $145 | $115 | NFPA 25 13.2.5.3 |
| SV-021 | Forward Flow Test — Fire Pump | Annual | 3.00 | $425 | $340 | NFPA 25 8.3 |
| SV-022 | 5-Year Internal Inspection | 5 Year | 6.00 | $850 | $680 | NFPA 25 14 |
| SV-023 | 50-Year Sprinkler Replacement (per head) | Once | 0.25 | $28 | $22 | NFPA 25 5.4.1.1 |
| SV-024 | Standpipe 5-Year Hydrostatic Test | 5 Year | 6.00 | $980 | $785 | NFPA 25 6.4 |
| SV-025 | Underground Flush | Annual | 2.00 | $280 | $225 | NFPA 25 14.4 |

### Fire Alarm Inspections (NFPA 72)
| Svc Code | Service | Frequency | Hrs | List | Contract | NFPA |
|---|---|---|---|---|---|---|
| SV-030 | Fire Alarm Inspection — Small (<25 devices) | Annual | 3.00 | $380 | $305 | NFPA 72 14 |
| SV-031 | Fire Alarm Inspection — Medium (25–100) | Annual | 5.50 | $620 | $495 | NFPA 72 14 |
| SV-032 | Fire Alarm Inspection — Large (101–300) | Annual | 9.00 | $980 | $785 | NFPA 72 14 |
| SV-033 | Fire Alarm Semi-Annual | Semi-Ann | 1.50 | $195 | $155 | NFPA 72 14.3 |
| SV-034 | Voice Evacuation System Test | Annual | 3.00 | $420 | $340 | NFPA 72 24 |
| SV-035 | Emergency Lighting / Exit Signs | Annual | 1.50 | $185 | $150 | NFPA 101 7.9 |

### Extinguisher Services (NFPA 10)
| Svc Code | Service | Frequency | Hrs | List | Contract | NFPA |
|---|---|---|---|---|---|---|
| SV-040 | Annual Extinguisher Service (per unit) | Annual | 0.20 | $18 | $14 | NFPA 10 7 |
| SV-041 | 6-Year Maintenance (ABC, per unit) | 6 Year | 0.50 | $55 | $44 | NFPA 10 7.3 |
| SV-042 | 12-Year Hydrostatic Test (per unit) | 12 Year | 0.50 | $75 | $60 | NFPA 10 8 |
| SV-043 | Recharge — ABC 10 lb (after discharge) | On Use | 0.30 | $38 | $30 | NFPA 10 |
| SV-044 | Recharge — CO2 10 lb | On Use | 0.30 | $48 | $38 | NFPA 10 |
| SV-045 | Recharge — Class K (Ansul) | On Use | 1.50 | $195 | $155 | NFPA 10 |

### Kitchen Hood Suppression (NFPA 96 / UL 300)
| Svc Code | Service | Frequency | Hrs | List | Contract | NFPA |
|---|---|---|---|---|---|---|
| SV-050 | Semi-Annual Hood Suppression Service | Semi-Ann | 1.50 | $245 | $195 | NFPA 96 / UL 300 |
| SV-051 | Annual Hood Suppression + Trip Test | Annual | 2.50 | $380 | $305 | NFPA 96 11.4 |
| SV-052 | Post-Discharge Cleaning & Recharge | On Use | 4.00 | $680 | $545 | NFPA 96 |
| SV-053 | Duct Cleaning Coordination | Annual | 1.00 | $125 | $100 | NFPA 96 11.6 |

### Fire Pump Services (NFPA 25 Ch. 8)
| Svc Code | Service | Frequency | Hrs | List | Contract | NFPA |
|---|---|---|---|---|---|---|
| SV-060 | Fire Pump Annual Test | Annual | 4.00 | $580 | $465 | NFPA 25 8.3 |
| SV-061 | Fire Pump Weekly Inspection | Weekly | 0.50 | $65 | $52 | NFPA 25 8.1 |
| SV-062 | Fire Pump Monthly No-Flow Test | Monthly | 1.00 | $125 | $100 | NFPA 25 8.2 |

### Backflow Preventer Testing
| Svc Code | Service | Frequency | Hrs | List | Contract |
|---|---|---|---|---|---|
| SV-070 | Backflow Test — RPZ 3/4"–2" | Annual | 0.75 | $145 | $115 |
| SV-071 | Backflow Test — RPZ 2.5"–4" | Annual | 1.00 | $195 | $155 |
| SV-072 | Backflow Test — DCVA 3/4"–2" | Annual | 0.50 | $95 | $75 |
| SV-073 | Backflow Repair — Minor (seats/O-rings) | On Need | 1.50 | $285 | $225 |

### Inspection Report & Compliance
| Svc Code | Service | Frequency | Hrs | List | Contract |
|---|---|---|---|---|---|
| SV-080 | Inspection Report — Standard | Per Visit | 0.50 | $75 | $60 |
| SV-081 | Deficiency Letter / Customer Copy | Per Visit | 0.50 | $55 | $44 |
| SV-082 | Emergency Inspection / Re-inspection | On Need | 2.00 | $385 | $310 |
| SV-083 | AHJ Coordination / Meeting | On Need | 2.00 | $295 | $235 |

### Monitoring Service (monthly recurring)
| Svc Code | Service | Frequency | List | Contract |
|---|---|---|---|---|
| SV-090 | Central Station Monitoring — Basic | Monthly | $38 | $30 |
| SV-091 | Central Station Monitoring — Premium | Monthly | $62 | $50 |
| SV-092 | IP Communicator — Monthly Airtime | Monthly | $18 | $14 |

---

## 6. Quotation Format

Every quote uses this structure. Line items are pulled from the sheets above; each
carries its **source sheet** and **part #/service/task code** for traceability.

```
QUOTE — [Customer / Location]
[Date]  |  Prepared by: [Tech]

#  | Source Sheet         | Code     | Description                  | Qty | Unit | Unit Price | Line Total
1  | Sprinkler Materials  | SP-010   | Tyco TY3151 Pendant 155°F    | 1   | EA   | $5.25      | $5.25
2  | Labor Benchmarks     | LH-002   | Replace head — drop ceiling  | 0.63| HR   | $75.00     | $47.25
3  | Labor Rates          | LB-030   | Scissor lift 19ft (day)      | 1   | DAY  | $245.00    | $245.00
...

Subtotal — Materials + Services : $X
Labor Subtotal                  : $Y
Tax / Other                     : $Z
TOTAL QUOTE                     : $X+Y+Z

Notes for Customer:
  - [NFPA compliance flags / advisories]
```

Rules:
- Use **exact codes and unit prices** from the pricebook. Never invent a price; if a
  needed item isn't listed, estimate and mark it as an assumption.
- Labor lines: `Qty` = hours (use the benchmark **Mid Hrs**), `Unit` = HR, `Unit
  Price` = the tier rate, `Line Total` = hours × rate.
- **Materials + Services subtotal** = all non-labor lines (materials, services,
  rentals, permits). **Labor subtotal** = labor lines only.
- Flag `Offline Req? = YES` tasks: add the drain-down / restore / impairment lines
  (LI-001…LI-004) and tell the customer the system goes offline.

---

## 7. Labor Benchmarks

The AI estimation table: match the **task + condition modifier** to get an hours
range and tier; multiply mid-hours × rate for the labor line. `Offline?` = YES means
the wet system must be drained — add LI-001..LI-004 and flag the customer.

### Rate assumptions
Tech I $55 · Tech II $75 · Tech III $95 · Tech IV $115 · Emergency $165 (per hour).

### Sprinkler Head Work
| Code | Task | Condition | Min | Max | Mid | Tier | Offline? |
|---|---|---|---|---|---|---|---|
| LH-001 | Replace single pendant/upright head | Open ceiling, accessible | 0.25 | 0.50 | 0.38 | Tech II | NO |
| LH-002 | Replace single pendant/upright head | Drop ceiling tile, need to cut | 0.50 | 0.75 | 0.63 | Tech II | NO |
| LH-003 | Replace single pendant/upright head | Concealed cover plate, ornamental | 0.50 | 1.00 | 0.75 | Tech II | NO |
| LH-004 | Replace painted-over head(s) | Per head, any ceiling | 0.50 | 0.75 | 0.63 | Tech II | NO |
| LH-005 | Replace 2–5 heads, same area | Open ceiling, grouped | 0.75 | 1.50 | 1.13 | Tech II | NO |
| LH-006 | Replace 6–20 heads, same area | Open ceiling, walkable | 2.00 | 4.00 | 3.00 | Tech II | YES |
| LH-007 | Replace head at height (>14ft) | Lift, open structure | 1.00 | 1.75 | 1.38 | Tech II | NO |
| LH-008 | Replace head at height (>14ft) | Lift, obstructed access | 1.50 | 2.50 | 2.00 | Tech II | NO |
| LH-009 | Add new head to existing branch | Open ceiling, existing tee | 0.75 | 1.25 | 1.00 | Tech II | YES |
| LH-010 | Relocate head (same zone) | Open ceiling | 1.00 | 2.00 | 1.50 | Tech II | YES |
| LH-011 | Drain down for head replacement | Wet system, one riser zone | 1.50 | 2.50 | 2.00 | Tech II | YES |

### Pipe & Fitting Work
| Code | Task | Condition | Min | Max | Mid | Tier | Offline? |
|---|---|---|---|---|---|---|---|
| LP-001 | Repair leak at threaded fitting | Accessible, ground level | 1.00 | 2.00 | 1.50 | Tech II | YES |
| LP-002 | Repair leak at grooved coupling | Accessible, ground level | 0.75 | 1.50 | 1.13 | Tech II | YES |
| LP-003 | Repair pinhole in pipe body | Cut & replace section | 2.00 | 4.00 | 3.00 | Tech II | YES |
| LP-004 | Add branch line (new tee off main) | Open ceiling, 1" branch | 2.00 | 3.50 | 2.75 | Tech II | YES |
| LP-005 | Reroute/relocate pipe section | Open ceiling, up to 10ft | 2.50 | 4.50 | 3.50 | Tech II | YES |
| LP-006 | Install escutcheon / trim | Per head, cosmetic | 0.10 | 0.20 | 0.15 | Tech I | NO |
| LP-007 | Underground pipe repair | Excavate 4ft section | 6.00 | 12.00 | 9.00 | Tech III | YES |

### Valve Work
| Code | Task | Condition | Min | Max | Mid | Tier | Offline? |
|---|---|---|---|---|---|---|---|
| LV-001 | Replace OS&Y gate valve 2"–3" | Flanged, riser room | 3.00 | 5.00 | 4.00 | Tech III | YES |
| LV-002 | Replace OS&Y gate valve 4"–6" | Flanged, riser room | 4.00 | 7.00 | 5.50 | Tech III | YES |
| LV-003 | Replace butterfly valve w/ tamper | Grooved, riser room | 2.00 | 3.50 | 2.75 | Tech II | YES |
| LV-004 | Replace check valve 2" | Threaded, accessible | 1.50 | 2.50 | 2.00 | Tech II | YES |
| LV-005 | Service/rebuild dry pipe valve | Trip test + reset | 4.00 | 6.00 | 5.00 | Tech III | YES |
| LV-006 | Service/rebuild deluge valve | Full inspection + reset | 4.50 | 7.00 | 5.75 | Tech III | YES |
| LV-007 | Replace pressure reducing valve 1" | Accessible | 1.00 | 2.00 | 1.50 | Tech II | YES |
| LV-008 | Add/replace tamper switch | Existing valve, field wiring | 1.00 | 1.75 | 1.38 | Tech II | NO |

### Fire Alarm — Devices & Field Wiring
| Code | Task | Condition | Min | Max | Mid | Tier | Offline? |
|---|---|---|---|---|---|---|---|
| LA-001 | Replace smoke detector (addressable) | Accessible, existing base | 0.25 | 0.50 | 0.38 | Tech II | NO |
| LA-002 | Replace smoke detector + new base | Accessible ceiling | 0.50 | 1.00 | 0.75 | Tech II | NO |
| LA-003 | Add new smoke detector (addressable) | Open ceiling, pull wire | 1.00 | 2.00 | 1.50 | Tech II | NO |
| LA-004 | Add new smoke detector | Wire fish, finished wall | 2.00 | 4.00 | 3.00 | Tech III | NO |
| LA-005 | Replace heat detector | Accessible ceiling | 0.25 | 0.50 | 0.38 | Tech II | NO |
| LA-006 | Replace duct smoke detector + housing | HVAC, above ceiling | 1.50 | 2.50 | 2.00 | Tech III | NO |
| LA-007 | Replace manual pull station | Wall mount, existing backbox | 0.50 | 0.75 | 0.63 | Tech II | NO |
| LA-008 | Replace horn/strobe | Wall or ceiling mount | 0.25 | 0.50 | 0.38 | Tech II | NO |
| LA-009 | Add horn/strobe (new + wire run) | <50ft run | 1.50 | 2.50 | 2.00 | Tech II | NO |
| LA-010 | Replace relay/control module | Accessible ceiling box | 0.50 | 1.00 | 0.75 | Tech II | NO |
| LA-011 | Add monitor module | Accessible, wire to device | 1.00 | 2.00 | 1.50 | Tech II | NO |
| LA-012 | Install flow switch (new) | Existing pipe, saddle + wire | 1.50 | 2.50 | 2.00 | Tech II | NO |
| LA-013 | Wire run — new cable pull | Per 100ft, accessible | 1.00 | 1.75 | 1.38 | Tech II | NO |
| LA-014 | Wire run — conduit fish | Per 50ft, finished walls | 2.00 | 4.00 | 3.00 | Tech III | NO |

### Fire Alarm — Panel & System Work
| Code | Task | Condition | Min | Max | Mid | Tier | Offline? |
|---|---|---|---|---|---|---|---|
| LP-101 | Reprogram addressable panel | Existing system, laptop on-site | 1.00 | 2.00 | 1.50 | Tech III | NO |
| LP-102 | Replace FACP — small (<50 pts) | Like-for-like, existing wiring | 6.00 | 10.00 | 8.00 | Tech III | YES |
| LP-103 | Replace FACP — large (50–200 pts) | Full cutover, re-address | 12.00 | 20.00 | 16.00 | Tech IV | YES |
| LP-104 | Replace batteries | 2× 12V batteries | 0.50 | 0.75 | 0.63 | Tech II | NO |
| LP-105 | Install/replace DACT / IP communicator | Panel room, ISP coord | 1.50 | 2.50 | 2.00 | Tech II | NO |
| LP-106 | Troubleshoot ground fault | System-wide trace | 2.00 | 6.00 | 4.00 | Tech III | NO |
| LP-107 | Troubleshoot open/short circuit | Per SLC loop | 2.00 | 5.00 | 3.50 | Tech III | NO |

### Extinguisher Tasks
| Code | Task | Condition | Min | Max | Mid | Tier | Offline? |
|---|---|---|---|---|---|---|---|
| LE-001 | Annual inspection — single unit | Wall mounted | 0.15 | 0.25 | 0.20 | Tech I | NO |
| LE-002 | Annual inspection — 10-unit site | Single floor | 1.00 | 1.50 | 1.25 | Tech I | NO |
| LE-003 | Annual inspection — 25+ units | Multi-floor | 2.50 | 4.00 | 3.25 | Tech I | NO |
| LE-004 | Recharge ABC 10 lb after discharge | Single unit | 0.25 | 0.50 | 0.38 | Tech I | NO |
| LE-005 | 6-year internal maintenance | Per unit, ABC | 0.40 | 0.60 | 0.50 | Tech II | NO |
| LE-006 | 12-year hydrostatic test | Per unit | 0.25 | 0.50 | 0.38 | Tech II | NO |
| LE-007 | Install wall bracket + mount | Drywall, single unit | 0.25 | 0.50 | 0.38 | Tech I | NO |
| LE-008 | Install recessed cabinet | Drywall cut | 1.50 | 2.50 | 2.00 | Tech II | NO |

### Kitchen Hood Suppression Tasks
| Code | Task | Condition | Min | Max | Mid | Tier | Offline? |
|---|---|---|---|---|---|---|---|
| LK-001 | Semi-annual service — 1 hood | Up to 6 nozzles | 1.25 | 1.75 | 1.50 | Tech II | NO |
| LK-002 | Semi-annual service — 2–3 hoods | Same kitchen | 2.00 | 3.00 | 2.50 | Tech II | NO |
| LK-003 | Replace fusible links (per hood) | Standard temp | 0.30 | 0.50 | 0.40 | Tech II | NO |
| LK-004 | Replace nozzle blow-off caps | All nozzles | 0.15 | 0.25 | 0.20 | Tech I | NO |
| LK-005 | Trip test (discharge test) | Expel agent | 1.00 | 1.50 | 1.25 | Tech II | YES |
| LK-006 | Post-discharge recharge + clean | Full degrease + refill | 3.50 | 5.00 | 4.25 | Tech II | NO |
| LK-007 | Replace fuel shutoff valve | Gas line, 3/4" | 1.50 | 2.50 | 2.00 | Tech III | YES |
| LK-008 | Replace pull station / actuator | Cable and actuator | 0.75 | 1.25 | 1.00 | Tech II | NO |

### System Impairment, Drain-Down & Restoration
| Code | Task | Condition | Min | Max | Mid | Tier | Offline? |
|---|---|---|---|---|---|---|---|
| LI-001 | Drain wet system — single zone | Riser shutoff, 1 floor | 1.50 | 2.50 | 2.00 | Tech II | YES |
| LI-002 | Drain wet system — multi-zone | Multiple risers, 3+ floors | 3.00 | 5.00 | 4.00 | Tech II | YES |
| LI-003 | Restore / refill wet system | Refill, bleed, pressure check | 1.50 | 2.50 | 2.00 | Tech II | YES |
| LI-004 | Impairment tag / fire watch coord | Notify AHJ, impairment form | 0.50 | 1.00 | 0.75 | Tech III | YES |
| LI-005 | Nitrogen charge dry system | After repair/annual reset | 1.00 | 1.75 | 1.38 | Tech II | YES |
| LI-006 | Low point drain dry system | Per drain point | 0.50 | 1.00 | 0.75 | Tech II | NO |

### Access, Setup & Site Conditions — Labor Adders
| Code | Task | Condition | Min | Max | Mid | Tier | Offline? |
|---|---|---|---|---|---|---|---|
| LS-001 | Scissor lift setup + operation | 19ft, flat concrete | 1.00 | 1.50 | 1.25 | Tech II | NO |
| LS-002 | Scissor lift setup + operation | 26ft, larger space | 1.25 | 2.00 | 1.63 | Tech II | NO |
| LS-003 | Boom lift operation | 40ft, outdoor | 1.50 | 2.50 | 2.00 | Tech II | NO |
| LS-004 | Roof/attic access | Pull-down stair or hatch | 0.50 | 1.00 | 0.75 | Tech II | NO |
| LS-005 | Confined space entry prep | Permit per OSHA | 1.00 | 2.00 | 1.50 | Tech III | NO |
| LS-006 | Opening / patching ceiling tiles | Per tile, 2x4 grid | 0.05 | 0.10 | 0.08 | Tech I | NO |
| LS-007 | Drywall opening + patch (not finish) | Per 12"×12" opening | 0.75 | 1.25 | 1.00 | Tech II | NO |
| LS-008 | After-hours / occupied building | Add to any task | 1.00 | 2.00 | 1.50 | Tech II | NO |
| LS-009 | Multi-story coordination | Per extra floor | 0.50 | 1.00 | 0.75 | Tech II | NO |

### Backflow Preventer Work
| Code | Task | Condition | Min | Max | Mid | Tier | Offline? |
|---|---|---|---|---|---|---|---|
| LBF-001 | Test RPZ 3/4"–2" (annual cert) | Accessible, test kit | 0.75 | 1.00 | 0.88 | Tech II | NO |
| LBF-002 | Test RPZ 2.5"–4" | Larger valve | 1.00 | 1.50 | 1.25 | Tech II | NO |
| LBF-003 | Rebuild RPZ / replace seats & O-rings | In-line, no excavation | 1.50 | 2.50 | 2.00 | Tech II | YES |
| LBF-004 | Replace full RPZ assembly 3/4"–1" | Flanged or union ends | 2.00 | 3.00 | 2.50 | Tech II | YES |

### Testing & Commissioning
| Code | Task | Condition | Min | Max | Mid | Tier | Offline? |
|---|---|---|---|---|---|---|---|
| LT-001 | Fire alarm functional test (per device) | Activate & verify | 0.15 | 0.25 | 0.20 | Tech II | NO |
| LT-002 | Main drain test (timed, gauges) | Full open drain | 0.75 | 1.25 | 1.00 | Tech II | NO |
| LT-003 | Hydrostatic test — sprinkler section | 200psi 2hrs | 3.00 | 5.00 | 4.00 | Tech III | YES |
| LT-004 | Fire pump annual test (full flow) | Churn + rated + 150% | 3.50 | 5.00 | 4.25 | Tech III | YES |
| LT-005 | Central station communication test | Test signal to monitoring | 0.25 | 0.50 | 0.38 | Tech II | NO |
| LT-006 | Acceptance test — new install | Full system, AHJ witness | 4.00 | 8.00 | 6.00 | Tech III | NO |

### Site Assessment & Scoping Visits
| Code | Task | Condition | Min | Max | Mid | Tier | Offline? |
|---|---|---|---|---|---|---|---|
| LQ-001 | Initial site survey — small | Single floor, 1 system | 1.00 | 1.50 | 1.25 | Tech III | NO |
| LQ-002 | Initial site survey — medium | Multi-floor, 2–3 systems | 2.00 | 3.50 | 2.75 | Tech III | NO |
| LQ-003 | Deficiency re-inspection | Verify corrections | 1.00 | 2.00 | 1.50 | Tech II | NO |
| LQ-004 | Emergency troubleshoot call | Alarm sounding, unknown cause | 2.00 | 4.00 | 3.00 | Tech III | NO |
| LQ-005 | System design review / plan markup | Review drawings | 2.00 | 4.00 | 3.00 | Tech IV | NO |
