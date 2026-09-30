-- Historical mobile schema v1 from 276b304; synthetic records only.
PRAGMA foreign_keys = OFF;
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
    );
INSERT INTO transactions (id,kind,description,planned_amount_cents,actual_amount_cents,due_date,settled_date,status,notes,created_at) VALUES ('legacy-manual','expense','Realizado zero',1234,0,'2026-08-10','2026-08-11','paid','á, 🦁
segunda linha','2026-08-10T12:00:00.000Z');
INSERT INTO transactions (id,kind,description,planned_amount_cents,actual_amount_cents,due_date,settled_date,status,notes,created_at) VALUES ('legacy-deleted','expense','Excluído antigo',1234,NULL,'2026-08-10',NULL,'planned','á, 🦁
segunda linha','2026-08-10T12:00:00.000Z');
CREATE INDEX transactions_due_date_idx ON transactions (due_date DESC, created_at DESC);
PRAGMA user_version = 1;
PRAGMA foreign_keys = ON;
