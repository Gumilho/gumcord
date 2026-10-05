package main

import (
	"testing"
)

func TestFreshDatabaseIsFullyMigrated(t *testing.T) {
	newTestApp(t)

	var version int
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != len(migrations) {
		t.Fatalf("user_version %d, want %d", version, len(migrations))
	}
	// A new database starts with the first server and its two channels.
	var channels int
	db.QueryRow(`SELECT COUNT(*) FROM channels`).Scan(&channels)
	if channels != 2 {
		t.Errorf("%d channels, want general and voice", channels)
	}
	rows, err := db.Query(`PRAGMA foreign_key_check`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	if rows.Next() {
		t.Error("foreign key violations in a new database")
	}
	var fk int
	db.QueryRow(`PRAGMA foreign_keys`).Scan(&fk)
	if fk != 1 {
		t.Error("foreign keys aren't enforced on the connection")
	}
}

func TestMigrateTwiceChangesNothing(t *testing.T) {
	newTestApp(t)
	migrate()
	var version int
	db.QueryRow(`PRAGMA user_version`).Scan(&version)
	if version != len(migrations) {
		t.Fatalf("user_version %d after a second run", version)
	}
}

func TestUpsertUser(t *testing.T) {
	newTestApp(t)
	u, err := upsertUser("sub-1", "Alice", "/files/avatar-a.png", false)
	if err != nil {
		t.Fatal(err)
	}
	if u.Name != "Alice" || u.Avatar != "/files/avatar-a.png" || u.Admin {
		t.Fatalf("%+v", u)
	}

	// Logging in again refreshes the name and admin status from the provider, and the same person
	// stays the same row. A failed picture import (empty) keeps the stored one.
	again, err := upsertUser("sub-1", "Alice B", "", true)
	if err != nil {
		t.Fatal(err)
	}
	if again.ID != u.ID || again.Name != "Alice B" || !again.Admin || again.Avatar != "/files/avatar-a.png" {
		t.Fatalf("%+v", again)
	}
}

func TestProfileCustomNameAndAvatarWin(t *testing.T) {
	a := newTestApp(t)
	alice := a.login("alice", false)

	alice.wantStatus(alice.do("PATCH", "/api/me", map[string]string{"name": "Ally"}), 200)
	if got := alice.get("/api/me").Body.String(); !contains(got, `"name":"Ally"`) {
		t.Fatalf("custom name not used: %s", got)
	}
	// Logging in again from the provider must not undo it.
	a.login("alice", false)
	if got := alice.get("/api/me").Body.String(); !contains(got, `"name":"Ally"`) {
		t.Fatalf("login overwrote the custom name: %s", got)
	}
	// An empty name goes back to the provider's.
	alice.wantStatus(alice.do("PATCH", "/api/me", map[string]string{"name": ""}), 200)
	if got := alice.get("/api/me").Body.String(); !contains(got, `"name":"alice"`) {
		t.Fatalf("name not reset: %s", got)
	}
}
