package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"path/filepath"

	_ "modernc.org/sqlite"
)

var db *sql.DB

func initDB(dataDir string) {
	var err error
	// WAL lets reads run alongside a write; busy_timeout makes concurrent writers wait instead of failing.
	dsn := "file:" + filepath.Join(dataDir, "gumcord.db") +
		"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)"
	db, err = sql.Open("sqlite", dsn)
	if err != nil {
		log.Fatal(err)
	}

	// The schema as first deployed. Later changes are the numbered migrations below, so an existing
	// database and a new one end up identical.
	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS users (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			subject    TEXT UNIQUE NOT NULL, -- the identity provider's "sub": stable even if name or email change
			name       TEXT NOT NULL,
			avatar     TEXT NOT NULL DEFAULT '', -- /files/ URL of the picture imported from the identity provider
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);

		CREATE TABLE IF NOT EXISTS channels (
			id   INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT UNIQUE NOT NULL,
			kind TEXT NOT NULL CHECK(kind IN ('text','voice'))
		);

		CREATE TABLE IF NOT EXISTS messages (
			id              INTEGER PRIMARY KEY AUTOINCREMENT,
			channel_id      INTEGER NOT NULL REFERENCES channels(id),
			user_id         INTEGER NOT NULL REFERENCES users(id),
			content         TEXT NOT NULL,
			attachment_url  TEXT NOT NULL DEFAULT '',
			attachment_type TEXT NOT NULL DEFAULT '',
			created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
		);

		-- History loads read one channel's newest messages.
		CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id);

		-- How loud each user hears each other user in voice. Only non-default settings are stored.
		CREATE TABLE IF NOT EXISTS user_audio (
			user_id   INTEGER NOT NULL REFERENCES users(id),
			target_id INTEGER NOT NULL REFERENCES users(id),
			volume    REAL NOT NULL DEFAULT 1, -- 0 to 2 (200%)
			muted     INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (user_id, target_id)
		);
	`)
	if err != nil {
		log.Fatal(err)
	}

	// Added before migrations were numbered; CREATE TABLE above already has it for new databases.
	addColumn("users", "avatar", "TEXT NOT NULL DEFAULT ''")
	migrate()
}

// Schema changes in order. PRAGMA user_version records how many have run.
var migrations = []func(*sql.Tx) error{
	migrateServers,
	migrateStreamAudio,
}

func migrate() {
	ctx := context.Background()
	// One connection throughout: foreign key enforcement can only be switched outside a transaction.
	conn, err := db.Conn(ctx)
	if err != nil {
		log.Fatal(err)
	}
	defer conn.Close()

	var version int
	if err := conn.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&version); err != nil {
		log.Fatal(err)
	}
	for i := version; i < len(migrations); i++ {
		// Rebuilding a table means dropping one that others reference, which enforcement would refuse.
		// Integrity is checked before committing instead.
		if _, err := conn.ExecContext(ctx, `PRAGMA foreign_keys = OFF`); err != nil {
			log.Fatal(err)
		}
		tx, err := conn.BeginTx(ctx, nil)
		if err != nil {
			log.Fatal(err)
		}
		if err := migrations[i](tx); err != nil {
			tx.Rollback()
			log.Fatalf("migration %d: %v", i+1, err)
		}
		var broken bool
		if rows, err := tx.Query(`PRAGMA foreign_key_check`); err == nil {
			broken = rows.Next()
			rows.Close()
		}
		if broken {
			tx.Rollback()
			log.Fatalf("migration %d left broken references", i+1)
		}
		if _, err := tx.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, i+1)); err != nil {
			tx.Rollback()
			log.Fatal(err)
		}
		if err := tx.Commit(); err != nil {
			log.Fatal(err)
		}
		if _, err := conn.ExecContext(ctx, `PRAGMA foreign_keys = ON`); err != nil {
			log.Fatal(err)
		}
		log.Printf("database migrated to version %d", i+1)
	}
}

// migrateServers groups channels into servers. The existing channels become the first server, and
// everyone who has signed in so far becomes a member of it.
func migrateServers(tx *sql.Tx) error {
	_, err := tx.Exec(`
		CREATE TABLE servers (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			name       TEXT NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);

		CREATE TABLE server_members (
			server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
			user_id   INTEGER NOT NULL REFERENCES users(id),
			joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			PRIMARY KEY (server_id, user_id)
		);

		INSERT INTO servers (id, name) VALUES (1, 'Gumcord');

		-- Channel names become unique per server instead of overall, which SQLite can only do by
		-- rebuilding the table. IDs are kept: messages and voice rooms refer to them.
		CREATE TABLE channels_new (
			id        INTEGER PRIMARY KEY AUTOINCREMENT,
			server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
			name      TEXT NOT NULL,
			kind      TEXT NOT NULL CHECK(kind IN ('text','voice')),
			UNIQUE (server_id, name)
		);
		INSERT INTO channels_new (id, server_id, name, kind) SELECT id, 1, name, kind FROM channels;
		DROP TABLE channels;
		ALTER TABLE channels_new RENAME TO channels;

		-- A new database starts with the usual two channels.
		INSERT INTO channels (server_id, name, kind)
			SELECT 1, 'general', 'text' WHERE NOT EXISTS (SELECT 1 FROM channels);
		INSERT INTO channels (server_id, name, kind)
			SELECT 1, 'voice', 'voice' WHERE NOT EXISTS (SELECT 1 FROM channels WHERE kind = 'voice');

		-- Admins manage servers; it comes from the identity provider at each login.
		ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

		INSERT INTO server_members (server_id, user_id) SELECT 1, id FROM users;
	`)
	return err
}

func addColumn(table, column, def string) {
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info(?) WHERE name = ?`, table, column).Scan(&n); err != nil {
		log.Fatal(err)
	}
	if n == 0 {
		if _, err := db.Exec(fmt.Sprintf(`ALTER TABLE %s ADD COLUMN %s %s`, table, column, def)); err != nil {
			log.Fatal(err)
		}
	}
}

// migrateStreamAudio adds per-person volume and mute for screen-share audio, separate from voice.
func migrateStreamAudio(tx *sql.Tx) error {
	if _, err := tx.Exec(`ALTER TABLE user_audio ADD COLUMN stream_volume REAL NOT NULL DEFAULT 1`); err != nil {
		return err
	}
	_, err := tx.Exec(`ALTER TABLE user_audio ADD COLUMN stream_muted INTEGER NOT NULL DEFAULT 0`)
	return err
}

// upsertUser records a login, refreshing the display name, picture and admin status from the
// identity provider. An empty avatar (the import failed, or dev login) keeps the one already stored.
func upsertUser(subject, name, avatar string, admin bool) (user, error) {
	u := user{Name: name, Admin: admin}
	err := db.QueryRow(`
		INSERT INTO users (subject, name, avatar, is_admin) VALUES (?, ?, ?, ?)
		ON CONFLICT(subject) DO UPDATE SET
			name = excluded.name,
			avatar = CASE WHEN excluded.avatar != '' THEN excluded.avatar ELSE users.avatar END,
			is_admin = excluded.is_admin
		RETURNING id, avatar`, subject, name, avatar, admin).Scan(&u.ID, &u.Avatar)
	return u, err
}
