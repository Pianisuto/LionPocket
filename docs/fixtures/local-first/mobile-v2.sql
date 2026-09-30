-- Historical mobile schema v2 from 276b304; synthetic records only.
PRAGMA foreign_keys = OFF;
CREATE TABLE cards (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL UNIQUE,
      due_day INTEGER NOT NULL CHECK (due_day BETWEEN 1 AND 31),
      closing_day INTEGER CHECK (closing_day BETWEEN 1 AND 31));
CREATE TABLE categories (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('income', 'expense')), color TEXT NOT NULL,
      UNIQUE(name, kind));
CREATE TABLE payment_methods (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL UNIQUE);
CREATE TABLE transactions (
      id TEXT PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('income', 'expense')),
      description TEXT NOT NULL,
      planned_amount_cents INTEGER NOT NULL CHECK (planned_amount_cents > 0),
      actual_amount_cents INTEGER,
      due_date TEXT NOT NULL,
      settled_date TEXT,
      status TEXT NOT NULL CHECK (status IN ('planned', 'paid', 'received', 'cancelled')),
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    , category_id TEXT REFERENCES categories(id), payment_method_id TEXT REFERENCES payment_methods(id), card_id TEXT REFERENCES cards(id), purchase_date TEXT, updated_at TEXT, deleted_at TEXT);
INSERT INTO cards (id,name,due_day,closing_day) VALUES ('legacy-card','Cartão próprio',21,NULL);
INSERT INTO categories (id,name,kind,color) VALUES ('legacy-category','Categoria própria','expense','#123456');
INSERT INTO payment_methods (id,name) VALUES ('legacy-payment','Pagamento próprio');
INSERT INTO transactions (id,kind,description,planned_amount_cents,actual_amount_cents,due_date,settled_date,status,notes,created_at,category_id,payment_method_id,card_id,purchase_date,updated_at,deleted_at) VALUES ('legacy-manual','expense','Realizado zero',1234,0,'2026-08-10','2026-08-11','paid','á, 🦁
segunda linha','2026-08-10T12:00:00.000Z','legacy-category','legacy-payment',NULL,NULL,'2026-08-10T12:00:00.000Z',NULL);
INSERT INTO transactions (id,kind,description,planned_amount_cents,actual_amount_cents,due_date,settled_date,status,notes,created_at,category_id,payment_method_id,card_id,purchase_date,updated_at,deleted_at) VALUES ('legacy-deleted','expense','Excluído antigo',1234,NULL,'2026-08-10',NULL,'planned','á, 🦁
segunda linha','2026-08-10T12:00:00.000Z','legacy-category','legacy-payment',NULL,NULL,'2026-08-10T12:00:00.000Z','2026-08-10T12:00:00.000Z');
CREATE INDEX transactions_due_date_idx ON transactions (due_date DESC, created_at DESC);
CREATE INDEX transactions_status_idx ON transactions (status, due_date);
PRAGMA user_version = 2;
PRAGMA foreign_keys = ON;
