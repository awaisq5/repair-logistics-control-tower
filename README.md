# Repair logistics control tower

Serialized tools that fail in the field go into a **repair & return (R&R) loop**: they wait to ship at the sending location, travel to a repair hub, get booked in and repaired, wait to ship out, and travel back. Every one of those steps can stall, and a stalled tool is working capital nobody can use.

This app tracks every unit through the loop's six stages, learns from history how long each stage normally takes **on each lane**, flags the units that are beyond that normal variation, and runs the escalation workflow until they move again.

![Live view: value in transit and pending, the six-stage loop, and pending units by country](docs/live.png)

## Where this comes from

In a supply chain leadership programme I worked on global repair logistics optimisation: I built a Power BI dashboard to monitor repair shipments stage by stage, set service-level thresholds for each logistics stage, used control charts to spot locations that were consistently out of line, and introduced escalation workflows with the regional logistics teams. As stated on my CV, the dashboard covered 10K+ shipments a year and $12M+ of shipment value, stagnant shipments fell by 18% and $1.5M of working capital was released.

This project rebuilds that method as an application: the same six stages, the same lane and country views, and the control-chart logic built in, so the escalation workflow runs on top of it instead of beside it. **All data in this repository is synthetic.** Countries are real so the lanes read naturally; every location, serial number, value and duration is generated.

> **Independent personal project.** I built this on my own time, after my employment ended, to show the kind of work I did professionally. It contains no code, data, documents, screenshots or other information belonging to any former employer, its customers or its suppliers. The method is rebuilt from general professional knowledge, all data in the repository is synthetic, and the only figures quoted from my career are the ones published on my CV.

## The six stages

| # | Stage | Starts at | Ends at | Limits grouped by |
|---|---|---|---|---|
| 1 | Pending at sending location | unit ready to ship | dispatch | sending country |
| 2 | In transit to repair hub | dispatch | goods receipt (GR) at hub | lane (country → hub) |
| 3 | GR to work order | goods receipt | work order (WO) opened | repair hub |
| 4 | In repair | work order opened | repair finished | repair hub |
| 5 | Waiting to ship out | repair finished | dispatch from hub | repair hub |
| 6 | In transit back | dispatch from hub | receipt at destination | lane (hub → country) |

Each stage is grouped by where its delay actually comes from: waiting to ship is a sending-country problem, booking-in and repair are hub problems, transit is a lane problem.

## From fixed service levels to control limits

A single service level ("escalate after 14 days in transit") treats a short European lane and a customs-heavy West African lane the same, so it is either too loose for one or too noisy for the other. Instead, every stage and group gets its own limits from the last 12 months of completed units, using an individuals (I-MR) control chart:

```
centre line  = average days
UCL          = average + 2.66 × average moving range
```

A unit above its UCL has been in its stage longer than that lane's normal variation explains: a **special cause**, worth a call to the regional logistics owner. The chart also flags sustained shifts (eight completed units in a row above average), which point to a lane problem rather than a single unit. Groups with fewer than eight completed units fall back to the limits of the whole stage.

![Control chart by sending country: each group with its own centre line and limits, special causes in red](docs/control-chart.png)

## What the app does

- **Live view.** Units and value in each of the six stages, the average days pending and in transit by country (the two live charts of the original dashboard), and every unit beyond its limit.
- **Lanes.** Average days per stage for every country-to-hub lane, stacked, so you can see whether a lane is slow because of the sending country, the road, or the hub.
- **Control charts.** The I-chart per stage, grouped by country, lane or hub, with special causes highlighted and a week-by-week count of units beyond their limit.
- **Escalations.** A scan, run every 15 minutes and on demand, opens one escalation per unit beyond its limit and suggests the regional logistics owner for that location. Recording the unit's next movement closes the escalation and counts its value as working capital moving again. The queue downloads as CSV for the weekly call with the regional teams.
- **Tool type history.** The unit detail compares the tech ID's completed loops with all other tool types, stage by stage, across every lane. A stage where it takes 1.5× as long or more, over at least five loops, is flagged: the tool type keeps stalling there, whatever the lane. Earlier loops of the same serial number are listed too. In the demo, steering units take longer in repair at every hub.
- **Load data.** Upload a movement export with seven dates per unit. Every row is checked first: dates out of order, gaps in the chain, future dates, a serial open twice. Problems are listed by row and never loaded. German date formats (05.03.2026) are accepted, as SAP exports often use them.

![Lane view: average days per stage on each country-to-hub lane](docs/lanes.png)

<img src="docs/unit-detail.png" alt="Unit detail: each stage's days against its control limit, and the form to record the next movement" width="420" />

## Architecture

```
client/   React + TypeScript (Vite)       live view, lanes, control charts, escalations, import
server/   Node.js + Express + TypeScript  REST API, control limits, escalation scan, CSV import
          PostgreSQL                      repair orders, region contacts, escalations
```

Design decisions:

- **One row per repair loop, seven dates.** That is how the data comes out of an ERP, so imports need no reshaping. The current stage is derived: the first stage without an end date.
- **The database enforces the process.** CHECK constraints keep the dates in loop order, a partial unique index allows only one open loop per serial number, and another allows only one active escalation per unit, even if two scans run at once.
- **The statistics are pure functions.** `server/src/domain/spc.ts` (control limits and special-cause rules) and `stages.ts` have no database or HTTP, and are unit-tested against hand-calculated charts.
- **Movements are transactional.** Recording a date and closing the escalation happen together with a row lock, so the history never contradicts the current state.
- **The clock is injectable,** which lets the integration tests move time forward.

### API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/overview` | Value per stage, live country views, units beyond limit, weekly trend |
| GET | `/api/units?stage=&country=&beyond=&q=` | Open units with their stage, days and limit |
| GET | `/api/units/:id` | One unit: every stage against its limit, escalation history, tool type and serial history |
| POST | `/api/units/:id/advance` | Record the end of the current stage `{ at?, note? }` |
| GET | `/api/lanes` | Average days per stage for each country-to-hub lane |
| GET | `/api/control-chart/:stage` | I-chart points and limits for each group |
| GET | `/api/escalations` | Active escalations with the suggested regional owner |
| GET | `/api/escalations.csv` | The active queue as CSV for the weekly regional call, with days in stage as of today |
| POST | `/api/escalations/scan` | Open escalations for units beyond their limit |
| POST | `/api/escalations/:id/acknowledge` | Take ownership `{ owner, note? }` |
| POST | `/api/escalations/:id/resolve` | Close with a note `{ note }` |
| POST | `/api/import?dryRun=true` | Check a CSV export; without `dryRun`, load the clean rows |

## Running it

**With Docker** (app and database):

```bash
docker compose up --build
# open http://localhost:4000
```

**Without Docker** (needs PostgreSQL 14+):

```bash
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/tower npm run dev -w server
npm run dev -w client   # http://localhost:5173, proxies /api to port 4000
```

On first start the server creates its tables and loads a synthetic network of about 1,400 repair loops over 18 months. Set `SEED_DEMO=false` to start empty and load your own export.

**Tests:**

```bash
npm test                                              # unit tests
TEST_DATABASE_URL=postgres://.../tower_test npm test  # plus API tests against a real database
```

CI runs both, with PostgreSQL as a service container, and builds the Docker image.

## Limits and next steps

- Stage durations are skewed (most units move quickly, a few stall for months), which widens I-chart limits. A log transform before charting would tighten them; the plain chart is kept here because it matches how the limits were read in practice.
- Carrier tracking and ERP goods-movement feeds to record dates automatically instead of by import or hand.
- Authentication and roles, so escalations route to the right regional team.

## License

MIT
