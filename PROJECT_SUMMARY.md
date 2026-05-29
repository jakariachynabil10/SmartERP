# SmartERP — Project Summary

**SmartERP** is a multi-tenant **ERP + Inventory + POS SaaS** application. Each business registers, gets an isolated workspace, and manages sales, stock, suppliers, and reporting from a single dashboard.

**Repository:** https://github.com/jakariachynabil10/SmartERP

---

## Tech Stack

| Layer | Technology |
|--------|------------|
| **Frontend** | Next.js 16, React 19, Tailwind CSS, Zustand, Recharts |
| **Backend** | Express, TypeScript, Prisma 5, JWT, Socket.io |
| **Database** | PostgreSQL with Row-Level Security (RLS) per tenant |
| **Cache / Rate limits** | Redis (in-memory fallback when Redis is unavailable) |
| **Deployment** | Docker Compose (Postgres, Redis, backend, frontend, nginx) |

---

## Architecture

- **Multi-tenant SaaS** — each tenant has isolated data via JWT context + Postgres RLS
- **REST API** at `http://localhost:5000/api/v1`
- **Web app** at `http://localhost:3000`
- **Real-time** — Socket.io for tenant room notifications

---

## Completed Features

### Authentication & Multi-Tenancy

- [x] Business registration (creates tenant, default warehouse, walk-in customer, owner user)
- [x] Login / logout / refresh token / user profile
- [x] Role-based access: `SUPER_ADMIN`, `BUSINESS_OWNER`, `MANAGER`, `STAFF`, `CASHIER`
- [x] SUPER_ADMIN seed script (`npm run seed:super-admin` in `backend/`)
- [x] Tenant isolation (JWT + AsyncLocalStorage + Postgres RLS)

**Default super admin credentials** (from `backend/.env`):

| Field | Value |
|--------|--------|
| Email | `superadmin@smarterp.local` |
| Password | `SuperAdmin@123` |

### Backend API (`/api/v1/...`)

| Module | Endpoints |
|--------|-----------|
| **Auth** | Register, login, refresh token, logout, profile |
| **Inventory** | Categories CRUD, products CRUD, low-stock alerts, stock adjust/transfer |
| **Warehouses** | Full CRUD |
| **Customers** | Full CRUD |
| **POS** | Checkout, offline sales sync |
| **Returns** | List returns, process return |
| **Suppliers** | Supplier CRUD, purchase orders, PO status updates |
| **Audit** | Paginated audit logs (role-restricted) |
| **Health** | `/health`, `/ready` |

### Security & Operations

- [x] Helmet, CORS, API rate limiting (disabled in development)
- [x] Structured logging (Pino)
- [x] Optional Sentry integration
- [x] Jest security tests
- [x] `backend/.gitignore` (env secrets, `node_modules`, `dist`, etc.)

### Frontend Pages

| Route | Description | Status |
|--------|-------------|--------|
| `/` | Login & registration | Done |
| `/dashboard` | Analytics overview, charts, recent audit activity | Done |
| `/dashboard/pos` | Point of sale, cart, checkout, offline queue | Done |
| `/dashboard/inventory` | Products, categories, warehouses, stock adjustment | Done |
| `/dashboard/suppliers` | Suppliers & purchase orders | Done |
| `/dashboard/audit` | Audit log table with filters & pagination | Done |
| `/dashboard/hr` | HR UI (employees, attendance, leave) | UI only (mock data) |

### Client-Side Features

- [x] Dark-themed dashboard with collapsible sidebar
- [x] Online/offline status indicator
- [x] Offline POS sales queue (Zustand + persistence)
- [x] Playwright e2e test scaffold for POS

### DevOps & Repository

- [x] Local development setup (backend port 5000, frontend port 3000)
- [x] Pushed to GitHub (`main` branch)
- [x] Docker Compose configuration for full stack

---

## Database Schema (Prisma)

Core models per tenant:

- **Tenant**, **User**
- **Category**, **Product**, **Warehouse**, **ProductWarehouse**
- **Supplier**, **Customer**
- **Sale**, **SaleItem**
- **ReturnTransaction**, **ReturnItem**
- **PurchaseOrder**, **PurchaseOrderItem**
- **Employee**, **Attendance**, **LeaveRequest**
- **AuditLog**
- **StockAdjustment**, **StockTransfer**

**Subscription plans:** `FREE`, `PRO`, `ENTERPRISE`

---

## Partially Done / Not Yet Wired

| Item | Notes |
|------|--------|
| **HR module** | Database schema exists; frontend uses placeholder data; no HR API routes |
| **Redis** | Optional; rate limiting falls back to in-memory store |
| **Docker production** | `docker-compose.yml` exists; local dev often uses native Postgres |
| **Stripe billing** | Environment placeholders only |
| **Analytics charts** | Mix of live API data and static demo revenue/profit figures |
| **Prisma 7** | Migration attempted; project remains on Prisma 5 |
| **Suppliers** | Core flows done; additional enhancements planned |

---

## How to Run Locally

### Prerequisites

- Node.js 20+
- PostgreSQL running locally
- `.env` configured in `backend/` (see `backend/.env.example`)

### Start Backend

```bash
cd backend
npm install
npx prisma db push
npm run seed:super-admin   # optional: create super admin
npm run dev
```

API: http://localhost:5000

### Start Frontend

```bash
cd frontend
npm install
npm run dev
```

App: http://localhost:3000

### Docker (optional)

```bash
docker compose up
```

Requires Docker installed. Serves via nginx on port 80 when all services are up.

---

## Project Structure

```
SmartERP/
├── backend/           # Express API, Prisma, JWT auth
│   ├── prisma/        # schema.prisma, seed.ts
│   ├── src/
│   │   ├── config/    # DB, Redis, RLS, logger
│   │   ├── controllers/
│   │   ├── middleware/
│   │   ├── routes/
│   │   └── server.ts
│   └── .env.example
├── frontend/          # Next.js dashboard & POS
│   └── src/app/
│       ├── page.tsx           # Login / register
│       └── dashboard/         # Module pages
├── nginx/             # Reverse proxy config
├── docker-compose.yml
└── PROJECT_SUMMARY.md # This file
```

---

## Environment Variables (Backend)

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection (optional) |
| `JWT_SECRET` | Access token signing |
| `JWT_REFRESH_SECRET` | Refresh token signing |
| `SUPER_ADMIN_EMAIL` | Seed script admin email |
| `SUPER_ADMIN_PASSWORD` | Seed script admin password |

---

## One-Line Summary

SmartERP is a working **multi-tenant ERP MVP** with authentication, inventory, POS, suppliers, returns, and audit logging — with HR integration and production hardening still in progress.

---

*Last updated: May 2026*
