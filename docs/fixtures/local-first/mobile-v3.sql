-- Historical mobile schema v3 from 276b304; synthetic records only.
PRAGMA foreign_keys = OFF;
CREATE TABLE cards (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL UNIQUE,
      due_day INTEGER NOT NULL CHECK (due_day BETWEEN 1 AND 31),
      closing_day INTEGER CHECK (closing_day BETWEEN 1 AND 31));
CREATE TABLE categories (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('income', 'expense')), color TEXT NOT NULL,
      UNIQUE(name, kind));
CREATE TABLE goals (
      id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, item_model TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '',
      category_id TEXT REFERENCES categories(id), target_amount_cents INTEGER NOT NULL CHECK(target_amount_cents > 0),
      saved_amount_cents INTEGER NOT NULL CHECK(saved_amount_cents >= 0), priority TEXT NOT NULL, due_date TEXT,
      status TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT, deleted_at TEXT
    );
CREATE TABLE installment_purchases (
      id TEXT PRIMARY KEY NOT NULL, description TEXT NOT NULL,
      category_id TEXT REFERENCES categories(id), payment_method_id TEXT REFERENCES payment_methods(id),
      card_id TEXT REFERENCES cards(id), installment_amount_cents INTEGER NOT NULL CHECK(installment_amount_cents > 0),
      total_installments INTEGER NOT NULL CHECK(total_installments > 0), starting_installment INTEGER NOT NULL DEFAULT 1,
      purchase_date TEXT, first_due_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
      notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT, deleted_at TEXT
    );
CREATE TABLE payment_methods (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL UNIQUE);
CREATE TABLE recurring_expenses (
      id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('income', 'expense')),
      active INTEGER NOT NULL DEFAULT 1, description TEXT NOT NULL,
      start_month TEXT NOT NULL, start_date TEXT NOT NULL, frequency TEXT NOT NULL,
      interval_count INTEGER NOT NULL DEFAULT 1, interval_unit TEXT NOT NULL DEFAULT 'months',
      anchor_to_actual INTEGER NOT NULL DEFAULT 0, manual_months TEXT NOT NULL DEFAULT '',
      category_id TEXT REFERENCES categories(id), payment_method_id TEXT REFERENCES payment_methods(id),
      card_id TEXT REFERENCES cards(id), planned_amount_cents INTEGER NOT NULL CHECK(planned_amount_cents > 0),
      due_day INTEGER NOT NULL, charge_day INTEGER, notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT, deleted_at TEXT
    );
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
    , category_id TEXT REFERENCES categories(id), payment_method_id TEXT REFERENCES payment_methods(id), card_id TEXT REFERENCES cards(id), purchase_date TEXT, updated_at TEXT, deleted_at TEXT, source_type TEXT NOT NULL DEFAULT 'manual', source_id TEXT, installment_number INTEGER, installment_total INTEGER, occurrence_date TEXT);
INSERT INTO cards (id,name,due_day,closing_day) VALUES ('legacy-card','Cartão próprio',21,NULL);
INSERT INTO categories (id,name,kind,color) VALUES ('legacy-category','Categoria própria','expense','#123456');
INSERT INTO goals (id,name,item_model,link,category_id,target_amount_cents,saved_amount_cents,priority,due_date,status,notes,created_at,updated_at,deleted_at) VALUES ('legacy-goal','Objetivo antigo','Modelo','https://example.test/item','legacy-category',10000,0,'high',NULL,'saving','Saldo absoluto','2026-08-10T12:00:00.000Z','2026-08-10T12:00:00.000Z','2026-08-10T12:00:00.000Z');
INSERT INTO installment_purchases (id,description,category_id,payment_method_id,card_id,installment_amount_cents,total_installments,starting_installment,purchase_date,first_due_date,status,notes,created_at,updated_at,deleted_at) VALUES ('legacy-purchase','Parcelas antigas','legacy-category','legacy-payment','legacy-card',2000,3,2,NULL,'2026-08-21','active','Preservar slots','2026-08-10T12:00:00.000Z','2026-08-10T12:00:00.000Z',NULL);
INSERT INTO payment_methods (id,name) VALUES ('legacy-payment','Pagamento próprio');
INSERT INTO recurring_expenses (id,kind,active,description,start_month,start_date,frequency,interval_count,interval_unit,anchor_to_actual,manual_months,category_id,payment_method_id,card_id,planned_amount_cents,due_day,charge_day,notes,created_at,updated_at,deleted_at) VALUES ('legacy-recurring','expense',1,'Série antiga','2026-08','2026-08-10','monthly',1,'months',0,'','legacy-category','legacy-payment',NULL,1234,10,NULL,'Preservar programação','2026-08-10T12:00:00.000Z','2026-08-10T12:00:00.000Z',NULL);
INSERT INTO transactions (id,kind,description,planned_amount_cents,actual_amount_cents,due_date,settled_date,status,notes,created_at,category_id,payment_method_id,card_id,purchase_date,updated_at,deleted_at,source_type,source_id,installment_number,installment_total,occurrence_date) VALUES ('legacy-manual','expense','Realizado zero',1234,0,'2026-08-10','2026-08-11','paid','á, 🦁
segunda linha','2026-08-10T12:00:00.000Z','legacy-category','legacy-payment',NULL,NULL,'2026-08-10T12:00:00.000Z',NULL,'manual',NULL,NULL,NULL,NULL);
INSERT INTO transactions (id,kind,description,planned_amount_cents,actual_amount_cents,due_date,settled_date,status,notes,created_at,category_id,payment_method_id,card_id,purchase_date,updated_at,deleted_at,source_type,source_id,installment_number,installment_total,occurrence_date) VALUES ('legacy-deleted','expense','Excluído antigo',1234,NULL,'2026-08-10',NULL,'planned','á, 🦁
segunda linha','2026-08-10T12:00:00.000Z','legacy-category','legacy-payment',NULL,NULL,'2026-08-10T12:00:00.000Z','2026-08-10T12:00:00.000Z','imported','arquivo-antigo:linha:7',NULL,NULL,NULL);
INSERT INTO transactions (id,kind,description,planned_amount_cents,actual_amount_cents,due_date,settled_date,status,notes,created_at,category_id,payment_method_id,card_id,purchase_date,updated_at,deleted_at,source_type,source_id,installment_number,installment_total,occurrence_date) VALUES ('legacy-occurrence','expense','Ocorrência editada',1234,NULL,'2026-08-12',NULL,'planned','á, 🦁
segunda linha','2026-08-10T12:00:00.000Z','legacy-category','legacy-payment',NULL,NULL,'2026-08-10T12:00:00.000Z',NULL,'recurring','legacy-recurring',NULL,NULL,'2026-08-10');
INSERT INTO transactions (id,kind,description,planned_amount_cents,actual_amount_cents,due_date,settled_date,status,notes,created_at,category_id,payment_method_id,card_id,purchase_date,updated_at,deleted_at,source_type,source_id,installment_number,installment_total,occurrence_date) VALUES ('legacy-installment','expense','Parcela',2000,2000,'2026-08-21','2026-08-21','paid','á, 🦁
segunda linha','2026-08-10T12:00:00.000Z','legacy-category','legacy-payment','legacy-card',NULL,'2026-08-10T12:00:00.000Z',NULL,'installment','legacy-purchase',2,3,NULL);
CREATE INDEX transactions_due_date_idx ON transactions (due_date DESC, created_at DESC);
CREATE UNIQUE INDEX transactions_generated_due_unique ON transactions(source_type, source_id, due_date)
      WHERE source_type != 'recurring' AND source_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX transactions_recurring_effective_unique ON transactions(source_id, COALESCE(purchase_date, due_date))
      WHERE source_type = 'recurring' AND source_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX transactions_recurring_occurrence_unique ON transactions(source_id, occurrence_date)
      WHERE source_type = 'recurring' AND occurrence_date IS NOT NULL;
CREATE INDEX transactions_source_idx ON transactions(source_type, source_id);
CREATE INDEX transactions_status_idx ON transactions (status, due_date);
PRAGMA user_version = 3;
PRAGMA foreign_keys = ON;
