-- Reethau Inventory Admin Portal — PostgreSQL schema
-- Run automatically by src/migrate.js on server boot (idempotent: safe to
-- run every time, only creates what's missing).

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  position       TEXT NOT NULL DEFAULT 'Anggota Tim',
  role           TEXT NOT NULL DEFAULT 'Site Manager'
                   CHECK (role IN ('Super Admin', 'Site Manager', 'Maintenance Engineer')),
  assigned_site  TEXT NOT NULL DEFAULT 'global',
  avatar_url     TEXT,
  created_at     DATE NOT NULL DEFAULT CURRENT_DATE
);

CREATE TABLE IF NOT EXISTS sites (
  key         TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  subtitle    TEXT NOT NULL DEFAULT 'Site Operasional',
  color       TEXT NOT NULL DEFAULT '#00D084',
  image_url   TEXT,
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  DATE NOT NULL DEFAULT CURRENT_DATE
);

CREATE TABLE IF NOT EXISTS spare_part_categories (
  name TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS product_energy_categories (
  name TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS spare_parts (
  id               TEXT PRIMARY KEY,
  sku              TEXT NOT NULL,
  name             TEXT NOT NULL,
  category         TEXT NOT NULL,
  product_energy   TEXT NOT NULL,
  site             TEXT NOT NULL REFERENCES sites(key) ON DELETE RESTRICT,
  stock            INTEGER NOT NULL DEFAULT 0,
  min_stock        INTEGER NOT NULL DEFAULT 0,
  unit             TEXT NOT NULL DEFAULT 'Units',
  price_estimate   NUMERIC NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'In Stock'
                     CHECK (status IN ('In Stock', 'Low Stock', 'Critical', 'Maintenance Needed')),
  last_inspected   DATE NOT NULL DEFAULT CURRENT_DATE,
  specifications   TEXT NOT NULL DEFAULT '',
  image_url        TEXT
);

CREATE INDEX IF NOT EXISTS idx_spare_parts_site ON spare_parts(site);
CREATE INDEX IF NOT EXISTS idx_spare_parts_sku ON spare_parts(sku);

CREATE TABLE IF NOT EXISTS activity_logs (
  id            TEXT PRIMARY KEY,
  -- Kept as free-text "YYYY-MM-DD HH:mm" (not a real TIMESTAMP column) to
  -- exactly match the sortable/parseable format the frontend already
  -- standardized on (see AdminDashboard's nowTimestamp()) — avoids a
  -- timezone-conversion mismatch between what the UI displays and stores.
  "timestamp"   TEXT NOT NULL,
  action        TEXT NOT NULL
                  CHECK (action IN ('TRANSFER', 'STOCK_UPDATE', 'ADD_SPARE_PART', 'DELETE_SPARE_PART',
                                     'ADD_FIXED_ASSET', 'WORK_ORDER')),
  description   TEXT NOT NULL,
  performed_by  TEXT NOT NULL,
  site_from     TEXT,
  site_to       TEXT
);

CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON activity_logs("timestamp" DESC);

CREATE TABLE IF NOT EXISTS gallery (
  id           TEXT PRIMARY KEY,
  site         TEXT NOT NULL REFERENCES sites(key) ON DELETE CASCADE,
  src          TEXT NOT NULL,
  caption      TEXT NOT NULL,
  description  TEXT,
  uploaded_by  TEXT,
  is_default   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   DATE NOT NULL DEFAULT CURRENT_DATE
);

CREATE INDEX IF NOT EXISTS idx_gallery_site ON gallery(site);

-- ── Fixed Assets (Asset Registry) ─────────────────────────────────────────
-- Distinct from spare_parts: these are capital/fixed assets (machinery,
-- inverters, vehicles, panels) tracked individually with acquisition cost
-- and depreciation, rather than consumable stock counted by quantity.
CREATE TABLE IF NOT EXISTS fixed_assets (
  id                   TEXT PRIMARY KEY,
  asset_code           TEXT NOT NULL UNIQUE,
  name                 TEXT NOT NULL,
  category             TEXT NOT NULL,
  site                 TEXT NOT NULL REFERENCES sites(key) ON DELETE RESTRICT,
  acquisition_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  acquisition_cost     NUMERIC NOT NULL DEFAULT 0,
  useful_life_years    INTEGER NOT NULL DEFAULT 5,
  salvage_value        NUMERIC NOT NULL DEFAULT 0,
  depreciation_method  TEXT NOT NULL DEFAULT 'straight-line'
                         CHECK (depreciation_method IN ('straight-line')),
  status               TEXT NOT NULL DEFAULT 'Active'
                         CHECK (status IN ('Active', 'Under Maintenance', 'Retired', 'Disposed')),
  serial_number        TEXT,
  warranty_expiry      DATE,
  notes                TEXT NOT NULL DEFAULT '',
  image_url            TEXT,
  created_at           DATE NOT NULL DEFAULT CURRENT_DATE
);

CREATE INDEX IF NOT EXISTS idx_fixed_assets_site ON fixed_assets(site);
CREATE INDEX IF NOT EXISTS idx_fixed_assets_category ON fixed_assets(category);

-- ── Work Orders (Scheduled / Preventive Maintenance) ──────────────────────
-- Distinct from spare_parts.status = 'Maintenance Needed' (a stock-level
-- flag): work orders are dated, assignable tasks against a specific fixed
-- asset, closer to how an EAM (SAP EAM / IBM Maximo) schedules PM work.
CREATE TABLE IF NOT EXISTS work_orders (
  id              TEXT PRIMARY KEY,
  asset_id        TEXT NOT NULL REFERENCES fixed_assets(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  type            TEXT NOT NULL DEFAULT 'Preventive'
                    CHECK (type IN ('Preventive', 'Corrective', 'Inspection')),
  priority        TEXT NOT NULL DEFAULT 'Medium'
                    CHECK (priority IN ('Low', 'Medium', 'High', 'Urgent')),
  status          TEXT NOT NULL DEFAULT 'Scheduled'
                    CHECK (status IN ('Scheduled', 'In Progress', 'Completed', 'Cancelled')),
  due_date        DATE NOT NULL,
  completed_date  DATE,
  assigned_to     TEXT,
  notes           TEXT NOT NULL DEFAULT '',
  created_at      DATE NOT NULL DEFAULT CURRENT_DATE
);

CREATE INDEX IF NOT EXISTS idx_work_orders_asset ON work_orders(asset_id);
CREATE INDEX IF NOT EXISTS idx_work_orders_due ON work_orders(due_date);