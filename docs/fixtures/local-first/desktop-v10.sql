-- Reconstructed desktop pre-11 schema from the additive migration in 276b304; synthetic records only.
PRAGMA foreign_keys = OFF;
CREATE TABLE cards (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        due_day INTEGER NOT NULL DEFAULT 10,
        closing_day INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
CREATE TABLE categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('income', 'expense')),
        color TEXT NOT NULL DEFAULT '#9C8AA5',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(name, kind)
      );
CREATE TABLE goals (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        item_model TEXT NOT NULL DEFAULT '',
        link TEXT NOT NULL DEFAULT '',
        category_id TEXT REFERENCES categories(id),
        target_cents INTEGER NOT NULL DEFAULT 0,
        saved_cents INTEGER NOT NULL DEFAULT 0,
        priority TEXT NOT NULL DEFAULT 'medium',
        due_date TEXT,
        status TEXT NOT NULL DEFAULT 'planned',
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
CREATE TABLE installment_purchases (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        category_id TEXT REFERENCES categories(id),
        payment_method_id TEXT REFERENCES payment_methods(id),
        card_id TEXT REFERENCES cards(id),
        installment_cents INTEGER NOT NULL,
        total_installments INTEGER NOT NULL,
        starting_installment INTEGER NOT NULL DEFAULT 1,
        purchase_date TEXT,
        first_due_date TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
CREATE TABLE migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
CREATE TABLE payment_methods (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
CREATE TABLE recurring_expenses (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'expense' CHECK(kind IN ('income', 'expense')),
        active INTEGER NOT NULL DEFAULT 1,
        description TEXT NOT NULL,
        start_month TEXT NOT NULL,
        start_date TEXT,
        frequency TEXT NOT NULL DEFAULT 'monthly',
        interval_count INTEGER NOT NULL DEFAULT 1,
        interval_unit TEXT NOT NULL DEFAULT 'months',
        anchor_to_actual INTEGER NOT NULL DEFAULT 0,
        manual_months TEXT NOT NULL DEFAULT '',
        category_id TEXT REFERENCES categories(id),
        payment_method_id TEXT REFERENCES payment_methods(id),
        card_id TEXT REFERENCES cards(id),
        planned_cents INTEGER NOT NULL DEFAULT 0,
        due_day INTEGER NOT NULL DEFAULT 1,
        charge_day INTEGER,
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
CREATE TABLE recurring_transaction_priorities (
        recurring_id TEXT PRIMARY KEY REFERENCES recurring_expenses(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK(position >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(position)
      );
CREATE TABLE transaction_priority_order (
        month TEXT NOT NULL,
        transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK(position >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(month, transaction_id),
        UNIQUE(month, position)
      );
CREATE TABLE transactions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('income', 'expense')),
        description TEXT NOT NULL,
        category_id TEXT REFERENCES categories(id),
        planned_cents INTEGER NOT NULL DEFAULT 0,
        actual_cents INTEGER,
        purchase_date TEXT,
        due_date TEXT NOT NULL,
        settled_date TEXT,
        status TEXT NOT NULL DEFAULT 'planned',
        payment_method_id TEXT REFERENCES payment_methods(id),
        card_id TEXT REFERENCES cards(id),
        notes TEXT NOT NULL DEFAULT '',
        source_type TEXT NOT NULL DEFAULT 'manual',
        source_id TEXT,
        installment_number INTEGER,
        installment_total INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
INSERT INTO cards (id,name,due_day,closing_day,created_at,updated_at) VALUES ('legacy-card','Cartão próprio',21,NULL,'2026-08-10T12:00:00.000Z','2026-08-10T12:00:00.000Z');
INSERT INTO categories (id,name,kind,color,created_at,updated_at) VALUES ('legacy-category','Categoria própria','expense','#123456','2026-08-10T12:00:00.000Z','2026-08-10T12:00:00.000Z');
INSERT INTO goals (id,name,item_model,link,category_id,target_cents,saved_cents,priority,due_date,status,notes,created_at,updated_at,deleted_at) VALUES ('legacy-goal','Objetivo antigo','Modelo','https://example.test/item','legacy-category',10000,0,'high',NULL,'saving','Saldo absoluto','2026-08-10T12:00:00.000Z','2026-08-10T12:00:00.000Z','2026-08-10T12:00:00.000Z');
INSERT INTO installment_purchases (id,description,category_id,payment_method_id,card_id,installment_cents,total_installments,starting_installment,purchase_date,first_due_date,status,notes,created_at,updated_at,deleted_at) VALUES ('legacy-purchase','Parcelas antigas','legacy-category','legacy-payment','legacy-card',2000,3,2,NULL,'2026-08-21','active','Preservar slots','2026-08-10T12:00:00.000Z','2026-08-10T12:00:00.000Z',NULL);
INSERT INTO migrations (version,applied_at) VALUES (1,'2026-08-10T12:00:00.000Z');
INSERT INTO migrations (version,applied_at) VALUES (2,'2026-08-10T12:00:00.000Z');
INSERT INTO migrations (version,applied_at) VALUES (3,'2026-08-10T12:00:00.000Z');
INSERT INTO migrations (version,applied_at) VALUES (4,'2026-08-10T12:00:00.000Z');
INSERT INTO migrations (version,applied_at) VALUES (5,'2026-08-10T12:00:00.000Z');
INSERT INTO migrations (version,applied_at) VALUES (6,'2026-08-10T12:00:00.000Z');
INSERT INTO migrations (version,applied_at) VALUES (7,'2026-08-10T12:00:00.000Z');
INSERT INTO migrations (version,applied_at) VALUES (8,'2026-08-10T12:00:00.000Z');
INSERT INTO migrations (version,applied_at) VALUES (9,'2026-08-10T12:00:00.000Z');
INSERT INTO migrations (version,applied_at) VALUES (10,'2026-08-10T12:00:00.000Z');
INSERT INTO payment_methods (id,name,created_at,updated_at) VALUES ('legacy-payment','Pagamento próprio','2026-08-10T12:00:00.000Z','2026-08-10T12:00:00.000Z');
INSERT INTO recurring_expenses (id,kind,active,description,start_month,start_date,frequency,interval_count,interval_unit,anchor_to_actual,manual_months,category_id,payment_method_id,card_id,planned_cents,due_day,charge_day,notes,created_at,updated_at,deleted_at) VALUES ('legacy-recurring','expense',1,'Série antiga','2026-08','2026-08-10','monthly',1,'months',0,'','legacy-category','legacy-payment',NULL,1234,10,NULL,'Preservar programação','2026-08-10T12:00:00.000Z','2026-08-10T12:00:00.000Z',NULL);
INSERT INTO recurring_transaction_priorities (recurring_id,position,created_at,updated_at) VALUES ('legacy-recurring',4,'2026-08-10T12:00:00.000Z','2026-08-10T12:00:00.000Z');
INSERT INTO transaction_priority_order (month,transaction_id,position,created_at,updated_at) VALUES ('2026-08','legacy-manual',8,'2026-08-10T12:00:00.000Z','2026-08-10T12:00:00.000Z');
INSERT INTO transactions (id,kind,description,category_id,planned_cents,actual_cents,purchase_date,due_date,settled_date,status,payment_method_id,card_id,notes,source_type,source_id,installment_number,installment_total,created_at,updated_at,deleted_at) VALUES ('legacy-manual','expense','Realizado zero','legacy-category',1234,0,NULL,'2026-08-10','2026-08-11','paid','legacy-payment',NULL,'á, 🦁
segunda linha','manual',NULL,NULL,NULL,'2026-08-10T12:00:00.000Z','2026-08-10T12:00:00.000Z',NULL);
INSERT INTO transactions (id,kind,description,category_id,planned_cents,actual_cents,purchase_date,due_date,settled_date,status,payment_method_id,card_id,notes,source_type,source_id,installment_number,installment_total,created_at,updated_at,deleted_at) VALUES ('legacy-deleted','expense','Excluído antigo','legacy-category',1234,NULL,NULL,'2026-08-10',NULL,'planned','legacy-payment',NULL,'á, 🦁
segunda linha','imported','arquivo-antigo:linha:7',NULL,NULL,'2026-08-10T12:00:00.000Z','2026-08-10T12:00:00.000Z','2026-08-10T12:00:00.000Z');
INSERT INTO transactions (id,kind,description,category_id,planned_cents,actual_cents,purchase_date,due_date,settled_date,status,payment_method_id,card_id,notes,source_type,source_id,installment_number,installment_total,created_at,updated_at,deleted_at) VALUES ('legacy-occurrence','expense','Ocorrência editada','legacy-category',1234,NULL,NULL,'2026-08-12',NULL,'planned','legacy-payment',NULL,'á, 🦁
segunda linha','recurring','legacy-recurring',NULL,NULL,'2026-08-10T12:00:00.000Z','2026-08-10T12:00:00.000Z',NULL);
INSERT INTO transactions (id,kind,description,category_id,planned_cents,actual_cents,purchase_date,due_date,settled_date,status,payment_method_id,card_id,notes,source_type,source_id,installment_number,installment_total,created_at,updated_at,deleted_at) VALUES ('legacy-installment','expense','Parcela','legacy-category',2000,2000,NULL,'2026-08-21','2026-08-21','paid','legacy-payment','legacy-card','á, 🦁
segunda linha','installment','legacy-purchase',2,3,'2026-08-10T12:00:00.000Z','2026-08-10T12:00:00.000Z',NULL);
CREATE INDEX transactions_due_date ON transactions(due_date);
CREATE UNIQUE INDEX transactions_other_source_unique
        ON transactions(source_type, source_id, due_date)
        WHERE source_type != 'recurring' AND source_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX transactions_recurring_source_unique
        ON transactions(source_id, COALESCE(purchase_date, due_date))
        WHERE source_type = 'recurring' AND source_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX transactions_status ON transactions(status);
PRAGMA user_version = 0;
PRAGMA foreign_keys = ON;
