# Repair logistics control tower

A control tower for **repair logistics**: high-value tools that fail in the field, travel to a repair centre, get fixed and travel back. Every stage of that loop has its own service level. This app shows which shipments are stuck, opens escalations automatically, gives each escalation an owner, and tracks the working capital that starts moving again once a shipment is unblocked.

![Dashboard with the verdict sentence, KPIs and the aging board](docs/screenshot.png)

## Why I built it

In a supply chain rotation I owned KPI reporting for a global repair logistics network: more than 10,000 shipments a year and over $12M in shipment value. We cut stagnant shipments by 18% and released $1.5M in working capital by introducing service-level thresholds and an escalation workflow. That workflow ran on a Power BI report and email. This project is the tool I would build for it: the thresholds live in one place, escalations open themselves, and every escalation has an owner and a history.

## What it does

- **SLA per stage.** Awaiting pickup, transit, customs, awaiting repair, in repair, return transit. Each stage has its own warning, escalation and critical thresholds, editable in the app.
- **High-value rule.** Shipments above a value threshold jump one level as soon as they breach, because a stuck €180k steering unit matters more than a stuck battery pack.
- **Aging board.** One row per stage, one tick per shipment placed by days in stage, drawn over that stage's SLA zones. You see at a glance where the network is clogged.
- **Escalation queue.** A scan, run every 15 minutes and on demand, opens one escalation per breaching shipment and raises it when the shipment gets worse. Someone takes ownership with a first action. Moving the shipment resolves the escalation automatically and counts its value as released.
- **Carrier and repair-centre breakdowns** of who holds the most value past SLA.
- **KPIs:** value in the repair loop, capital released in the last 30 days, share of stage moves inside SLA, average turnaround.

<img src="docs/shipment-detail.png" alt="Shipment detail with waybill fields, move action and journey timeline" width="420" />

## Architecture

```
client/   React + TypeScript (Vite)       aging board, queue, drawer, SLA editor
server/   Node.js + Express + TypeScript  REST API, escalation scan, KPI queries
          PostgreSQL                      shipments, stage history, SLA rules, escalations
```

Design decisions worth pointing out:

- **The rules engine is pure.** `server/src/domain/sla.ts` takes a shipment, a policy and a clock, and returns a level. No database, no HTTP, so it is fully unit-tested.
- **The database enforces the workflow.** A partial unique index (`escalations_one_active`) makes it impossible for a shipment to have two active escalations, even if two scans run at once. CHECK constraints keep SLA thresholds in increasing order.
- **Stage moves are transactional.** Closing the old stage, opening the new one, updating the shipment and resolving its escalation happen in one transaction with a row lock, so the history never contradicts the current state.
- **Time is injectable.** The API takes a clock, which lets integration tests move forward a week and check that an acknowledged escalation re-opens when the shipment turns critical.
- **Validation at the edge.** Request bodies are checked with Zod, and errors explain what to fix ("Thresholds must increase: warning, then escalation, then critical.").

### API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/shipments?level=&stage=&carrier=&q=` | Open shipments with their SLA evaluation |
| GET | `/api/shipments/:id` | Shipment, stage history and escalations |
| POST | `/api/shipments/:id/advance` | Move to the next stage `{ to, note? }` |
| GET | `/api/escalations?status=active\|resolved` | Escalation queue |
| POST | `/api/escalations/scan` | Open or raise escalations now |
| POST | `/api/escalations/:id/acknowledge` | Take ownership `{ owner, note? }` |
| POST | `/api/escalations/:id/resolve` | Close with a note `{ note }` |
| GET / PUT | `/api/sla` | SLA rules and high-value threshold |
| GET | `/api/kpis` | Dashboard figures |

## Running it

**With Docker** (app and database):

```bash
docker compose up --build
# open http://localhost:4000
```

**Without Docker** (needs PostgreSQL 14+):

```bash
npm install
createdb tower   # or point DATABASE_URL at any empty database
DATABASE_URL=postgres://user:pass@localhost:5432/tower npm run dev -w server
npm run dev -w client   # http://localhost:5173, proxies /api to port 4000
```

On first start the server creates its tables and loads a synthetic demo network (260 shipments across five carriers and four repair centres). Set `SEED_DEMO=false` to start empty.

**Tests:**

```bash
npm test                                              # unit tests
TEST_DATABASE_URL=postgres://.../tower_test npm test  # plus API tests against a real database
```

CI runs both, with PostgreSQL as a service container, and builds the Docker image.

## Data

All data is synthetic. Carriers, references and serial numbers are invented. The tool types and price ranges are modelled on drilling-tool repair loops so the numbers feel realistic.

## Next steps

- Authentication and roles (logistics coordinator, team lead, manager), so escalation levels route to the right people.
- Carrier tracking webhooks to move stages automatically instead of by hand.
- Email or Teams notification when an escalation opens or turns critical.
- Read shipments from SAP deliveries and repair orders instead of seeding them.

## License

MIT
