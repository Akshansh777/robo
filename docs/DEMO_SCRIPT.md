# 4-Minute Hackathon Demo Script (Matches In-App "Demo Mode")

- **0:00 - 0:35 | Stage 1: Narrow Aisle Showdown & Predictive Deadlock Prevention**
  - *Action*: Load **Narrow Aisle Showdown** (`seed=42`). Enable the **Wait Graph** overlay.
  - *Narrative*: Two robots enter a 1-cell-wide corridor head-on. Before either robot stalls, the 10-tick projected wait-for graph detects the cycle and preemptively backs the lower-priority robot into a recessed `bay`.
- **0:35 - 1:25 | Stage 2: Contract Net Bidding & Battery Safety Reserves**
  - *Action*: Switch to **Kiva Grid** (`seed=1337`). Inspect fleet battery levels in the right telemetry cluster.
  - *Narrative*: Show how low-battery robots refuse bids that lack round-trip + charger energy reserves and route to perimeter chargers instead of stranding cargo.
- **1:25 - 2:25 | Stage 3: Mid-Route Carrier Failure & Tamper-Evident Custody Rescue**
  - *Action*: Trigger `FAIL_ROBOT` on `R-01` while carrying a pod and `BLOCK_CELL` on aisle `(6,5)`. Open the **Custody** tab.
  - *Narrative*: `R-01` becomes a physical obstacle, its package transitions atomically to `STRANDED` with an incremented fencing epoch, and an `URGENT` rescue job dispatches another robot. Even if `R-01` recovers later, drops with its stale epoch are rejected while the badge stays green: `0 duplicate carries - 0 double deliveries - chain verified`.
- **2:25 - 3:20 | Stage 4: Time-Travel Scrubber & A/B Policy Branching**
  - *Action*: Drag the bottom timeline scrubber back 12 ticks and click **Branch with Policy** (`AUCTION_REBID`).
  - *Narrative*: Compare both live arenas and throughput/delay sparklines side-by-side over the exact same chaos stream.
- **3:20 - 4:00 | Stage 5: Hospital Corridor, Human Safety Buffers & Copilot Post-Mortem**
  - *Action*: Switch to **Hospital Corridor**, move the simulated staff member across the central concourse, and click **Post-Mortem** in the Supervisor Copilot bar.
  - *Narrative*: Robots halt before entering the protective human buffer, traverse MRI RF `deadzone` cells with a wider 2-cell halo, and produce a deterministic root-cause explanation from the Decision Timeline.
