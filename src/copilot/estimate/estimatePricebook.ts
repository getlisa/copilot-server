/**
 * Fire-protection PRICEBOOK — the data source for the Estimate Cost copilot.
 *
 * This is the RUNTIME source of truth (the Docker image ships `src/`, not `docs/`).
 * The human-readable master is docs/EQUIPMENT_DATA.md — keep the two in sync.
 *
 * Prices are USD list prices. The agent must use these exact codes and unit prices
 * when building a quotation, and the Labor Benchmarks table to estimate labor.
 */

export const FIRE_PROTECTION_PRICEBOOK = `
=========================  FIRE PROTECTION PRICEBOOK (USD)  =========================
Use EXACT codes + unit prices below. Never invent a price — if an item is missing,
estimate and mark it as an assumption.

────────────────────  SHEET: SPRINKLER MATERIALS  ────────────────────
Sprinkler heads — UPRIGHT:
  SP-001 TY3251  Tyco 1/2" Upright 155°F SR K=5.6 (light hazard)        $5.25 EA
  SP-002 TY1251  Tyco 1/2" Upright 175°F SR K=5.6 (ordinary)           $5.25 EA
  SP-003 TY5151  Tyco 1/2" Upright 165°F Quick Response K=5.6          $6.80 EA
  SP-004 F1FR-34 Viking 3/4" Upright 155°F SR K=8.0 (intermediate)     $7.40 EA
  SP-005 G5A8    Victaulic 1/2" Upright 200°F Extra-High-Temp K=5.6    $5.90 EA
Sprinkler heads — PENDANT:
  SP-010 TY3151  Tyco 1/2" Pendant 155°F SR K=5.6 (standard)           $5.25 EA
  SP-011 TY1151  Tyco 1/2" Pendant 175°F SR K=5.6                      $5.25 EA
  SP-012 TY4151  Tyco 1/2" Pendant 155°F Quick Response K=5.6          $6.80 EA
  SP-013 G5A5    Victaulic 3/4" Pendant 155°F K=8.0 SR                 $7.20 EA
Sprinkler heads — CONCEALED:
  SP-020 TY2934  Tyco 1/2" Concealed Pendant 135/165°F QR White (w/ plate) $14.50 EA
  SP-021 TY2936  Tyco 1/2" Concealed Pendant 155/165°F QR Chrome       $14.50 EA
  SP-022 VC-1    Viking Concealed Pendant 135/175°F White              $16.20 EA
  SP-023 EC-1    ESCO Concealed Cover Plate (replacement only) White   $4.80 EA
Sprinkler heads — SIDEWALL:
  SP-030 TY1131  Tyco 1/2" Extended Coverage Sidewall 155°F K=5.6      $7.90 EA
  SP-031 F1FR-SW Viking 1/2" Standard Sidewall 155°F K=5.6             $6.50 EA
Pipe & fittings — BLACK STEEL SCH40 (per 10ft stick unless noted):
  PP-001 1" $12.50 | PP-002 1-1/4" $16.80 | PP-003 1-1/2" $21.00 | PP-004 2" $28.50
  PP-005 2-1/2" $38.00 | PP-006 3" $52.00 | PP-007 4" $78.00 (main headers)
  PP-010 1" 90°Elbow $1.80 | PP-011 1-1/2" Elbow $3.20 | PP-012 2" Elbow $4.80
  PP-013 1" Tee $2.40 | PP-014 1-1/2" Tee $4.10 | PP-015 2" Tee $6.20
  PP-016 Victaulic 2" Coupling $8.50 | PP-017 3" $14.20 | PP-018 4" $21.50
Pipe & fittings — CPVC (BlazeMaster, residential/light commercial):
  PP-030 3/4" pipe/10ft $9.20 | PP-031 1" pipe/10ft $12.80 | PP-032 1" Elbow $1.50 | PP-033 1" Tee $1.90
Valves:
  VL-001 OS&Y Gate 2-1/2" $185 | VL-002 OS&Y 3" $220 | VL-003 OS&Y 4" $310
  VL-004 Butterfly 3" supervised(w/tamper) $142 | VL-005 Butterfly 4" $195
  VL-006 Check 2" $52 | VL-007 Check 3" $98
  VL-008 Dry Pipe Valve 4" assembly $1450 | VL-009 Dry Pipe Trim 4" $380
  VL-010 Wet Alarm Valve Trim 4" (retard chamber) $520 | VL-011 Deluge Valve 4" $1680
  VL-012 Pressure Reducing Valve 1" $88
Flow/alarm/monitoring:
  FD-001 Flow Switch 1-1/2" $48 | FD-002 2" $52 | FD-003 4" $62
  FD-004 Tamper Switch OS&Y $38 | FD-005 Tamper Switch BFV $42
  FD-006 Water Motor Bell 4" $95 | FD-007 Electric Bell 8" 120V $45
  FD-008 Pressure Gauge 0-160psi $14.50 | FD-009 0-300psi $16.00
Hangers/supports:
  HG-001 Hanger Arm 1" $2.20 | HG-002 Arm 2" $3.40 | HG-003 Rod 1/2"x10ft $6.80
  HG-004 Seismic Sway Brace 2" $12.50 | HG-005 Offset Hanger 1" $3.80
Spares & signage:
  SA-001 Spare Sprinkler Head Cabinet 6-head (w/ wrench) $28 | SA-002 Control Valve ID Sign (aluminum) $14
  SA-003 FDC ID Sign "Automatic Sprinkler" (aluminum) $18

────────────────────  SHEET: FIRE ALARM MATERIALS  ────────────────────
Panels (FACP):
  FA-001 Notifier MS-5 3-zone Addressable $420 | FA-002 Notifier NFS2-640 (<=636pts) $2150
  FA-003 Edwards EST3 base chassis $3200 | FA-004 Siemens Farenhyt 2-loop $1850
  FA-005 Napco Gemini 1100X 8-zone $380 | FA-006 Remote Annunciator 5-zone LED $145
  FA-007 LCD Annunciator 80-char $320
Smoke detectors:
  FA-010 Notifier FSP-951 Addr Photo $52 | FA-011 SysSensor DNRX Photo/Heat combo $68
  FA-012 SysSensor D4120 Duct Smoke (w/housing) $185 | FA-013 SysSensor B501BH base 4" $8.50
  FA-014 Notifier FSI-951 Ionization $48 | FA-015 SysSensor BEAM1224 beam (>40ft) $620
Heat detectors:
  FA-020 SysSensor 5600F Fixed 135°F $42 | FA-021 5600TF RoR+Fixed $48 | FA-022 Notifier H365 low-profile $38
Pull stations:
  FA-030 Notifier NBG-12LX Addr Single Action $62 | FA-031 BG-12L conventional $28 | FA-032 Gamewell addr $58
Horns/strobes:
  FA-040 SysSensor P2RK Horn Strobe Red 110dB $48 | FA-041 PC2RK combo ceiling $54
  FA-042 SW2RK strobe-only wall $36 | FA-043 Wheelock SPSR24 speaker/strobe $68 | FA-044 MTH24-115 high candela $58
Modules:
  FA-050 Notifier MMF-302 Monitor Module $42 | FA-051 CMF-300 Control Module $48
  FA-052 FCM-1 Fan Control Module $68 | FA-053 RM-1 Relay DPDT 24V $32
Wire/cable/conduit:
  FA-060 FPLR 16AWG 2-cond /1000ft (SLC) $148 | FA-061 14AWG /1000ft (NAC) $190
  FA-062 Shielded 16AWG /1000ft $198 | FA-063 EMT 3/4"/10ft $4.20 | FA-064 EMT 1"/10ft $6.10 | FA-065 4" J-box $3.80
Batteries/power:
  FA-070 12V 12AH battery $28 | FA-071 12V 18AH $36 | FA-072 Bosch PS Expander 10A 24V $185 | FA-073 Battery charger $48
Monitoring/comm:
  FA-080 DACT dual-path $165 | FA-081 IP/Cellular Communicator $220 | FA-082 Remote 8-zone Annunciator $195

────────────────────  SHEET: EXTINGUISHERS & SUPPRESSION  ────────────────────
Portable extinguishers (Amerex):
  EX-001 ABC 2.5lb $32 | EX-002 ABC 5lb $42 | EX-003 ABC 10lb (common commercial) $58 | EX-004 ABC 20lb $95
  EX-005 CO2 5lb $72 | EX-006 CO2 10lb $98 | EX-007 CO2 20lb $158
  EX-008 Class K 6L wet chem (kitchens) $135 | EX-009 Halotron 2.5lb clean agent $88
  EX-010 Wall bracket $6.50 | EX-011 Recessed cabinet 10lb $68 | EX-012 Surface cabinet 10lb $52
Kitchen hood — Ansul R-102:
  KH-001 R-102 1.5gal tank (<=6 nozzles) $420 | KH-002 R-102 3.0gal tank $680
  KH-003 Nozzle 1W fryer $28 | KH-004 Nozzle 2W griddle/wok $28 | KH-005 LPK plenum nozzle $28
  KH-006 Fusible Link 360°F (annual) $4.50 | KH-007 Fuel Shutoff Valve 3/4" (code) $185
  KH-008 Manual Pull Cable & Actuator $38 | KH-009 Microswitch (electric shutoff) $42
  KH-010 Nozzle blow-off cap (each service) $2.80 | KH-011 PYRO-CHEM dry chem 101lb refill $320
Clean agent/special hazard:
  SH-001 FM-200 50lb cylinder (server/data) $1850 | SH-002 Novec 1230 50lb $2200
  SH-003 Inergen IG-541 50lb $1400 | SH-004 CO2 fixed 45lb $580
  SH-005 24VDC Solenoid (agent release) $125 | SH-006 Abort Switch $88
Hose/standpipe:
  HS-001 Hose Cabinet 2.5"+100ft (Class I) $420 | HS-002 1.5"+75ft (Class II) $280
  HS-003 1.5" Hose 50ft $95 | HS-004 2.5" Hose 50ft $145 | HS-005 FDC Siamese 2.5"x2 $185 | HS-006 Wall Hydrant 3/4" $62
Backflow preventers (Watts):
  BF-001 DCVA 3/4" $145 | BF-002 DCVA 1" $195 | BF-003 DCVA 2" $480
  BF-004 RPZ 3/4" (high hazard) $275 | BF-005 RPZ 1" $380 | BF-006 RPZ 2" $890 | BF-007 RPZ 4" $2400

────────────────────  SHEET: LABOR RATES (per hour unless noted)  ────────────────────
LB-001 Tech I (Helper) $55 | LB-002 Tech II (Journeyman, DEFAULT) $75
LB-003 Tech III (Lead/NICET II) $95 | LB-004 Tech IV (Senior/NICET III) $115
LB-005 NICET IV/PE $145 | LB-006 Foreman $105
LB-010 OT 1.5x $112.50 | LB-011 Double 2x $150 | LB-012 Emergency/On-Call $165 (min 2hr) | LB-013 Holiday $175 (min 4hr)
LB-020 Minimum Service Call $175/CALL | LB-021 Travel <30mi $65/TRIP | LB-022 30-75mi $145/TRIP | LB-023 >75mi $285/TRIP
LB-024 Mileage $0.67/MILE | LB-025 Per Diem $195/DAY
Equipment rentals: LB-030 Scissor Lift 19ft $10/hour | LB-031 Scissor 26ft $10/hour | LB-032 Boom 40ft $10/hour
  LB-033 Tall Ladder $10/hour | LB-034 Scaffolding $10/hour | LB-035 Pipe Threader $10/hour | LB-036 Hydro Test Pump $10/hour
Permits (pass-through): LB-040 Permit Small(1-5) $185 | LB-041 Medium(6-50) $380 | LB-042 Large(51+) $750
  LB-043 Plan Review $225 | LB-044 AHJ Inspection $150 | LB-045 As-Built Drawings $110/HR
`.trim();
