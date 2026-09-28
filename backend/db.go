package main

import (
	"database/sql"
	"log"

	_ "modernc.org/sqlite"
)

var db *sql.DB

func initDB() {
	var err error
	db, err = sql.Open("sqlite", "gumcord.db")
	if err != nil {
		log.Fatal(err)
	}

	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS users (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			username   TEXT UNIQUE NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);

		CREATE TABLE IF NOT EXISTS channels (
			id   INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT UNIQUE NOT NULL,
			kind TEXT NOT NULL CHECK(kind IN ('text','voice'))
		);

		CREATE TABLE IF NOT EXISTS messages (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			channel_id INTEGER NOT NULL REFERENCES channels(id),
			user_id    INTEGER NOT NULL REFERENCES users(id),
			content    TEXT NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);

		-- History loads read one channel's newest messages.
		CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id);

		INSERT OR IGNORE INTO channels (name, kind) VALUES ('general','text'),('voice','voice');
	`)
	if err != nil {
		log.Fatal(err)
	}

	// Additive migrations; errors mean the column already exists.
	db.Exec(`ALTER TABLE messages ADD COLUMN attachment_url TEXT`)
	db.Exec(`ALTER TABLE messages ADD COLUMN attachment_type TEXT`)
}
