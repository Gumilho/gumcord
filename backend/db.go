package main

import (
	"database/sql"
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

	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS users (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			subject    TEXT UNIQUE NOT NULL, -- the identity provider's "sub": stable even if name or email change
			name       TEXT NOT NULL,
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

		INSERT OR IGNORE INTO channels (name, kind) VALUES ('general','text'),('voice','voice');
	`)
	if err != nil {
		log.Fatal(err)
	}
}

// upsertUser records a login, refreshing the display name from the identity provider each time.
func upsertUser(subject, name string) (user, error) {
	u := user{Name: name}
	err := db.QueryRow(`
		INSERT INTO users (subject, name) VALUES (?, ?)
		ON CONFLICT(subject) DO UPDATE SET name = excluded.name
		RETURNING id`, subject, name).Scan(&u.ID)
	return u, err
}
