package main

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBackupDBIsAConsistentCopy(t *testing.T) {
	a := newTestApp(t)
	admin := a.login("admin", true)
	_, channelID := a.newServer(admin, "Backed up")
	a.addMessage(channelID, admin, "remember me")

	path, err := backupDB(autoBackupPrefix)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(path) != backupDir || !strings.HasPrefix(filepath.Base(path), "auto-") || !strings.HasSuffix(path, ".db") {
		t.Fatalf("unexpected backup path %s", path)
	}
	if leftovers, _ := filepath.Glob(filepath.Join(backupDir, "*.tmp")); len(leftovers) > 0 {
		t.Errorf("temporary files left behind: %v", leftovers)
	}

	// Opened on its own, it has the data and the same schema version.
	copyDB, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer copyDB.Close()
	var content string
	if err := copyDB.QueryRow(`SELECT content FROM messages WHERE channel_id = ?`, channelID).Scan(&content); err != nil || content != "remember me" {
		t.Fatalf("message in backup: %q, %v", content, err)
	}
	var version int
	copyDB.QueryRow(`PRAGMA user_version`).Scan(&version)
	if version != len(migrations) {
		t.Errorf("backup is at schema version %d, want %d", version, len(migrations))
	}
	var check string
	copyDB.QueryRow(`PRAGMA integrity_check`).Scan(&check)
	if check != "ok" {
		t.Errorf("integrity_check: %s", check)
	}
}

func TestBackupsDoNotChangeTheLiveDatabase(t *testing.T) {
	a := newTestApp(t)
	admin := a.login("admin", true)
	if _, err := backupDB(autoBackupPrefix); err != nil {
		t.Fatal(err)
	}
	// Still writable and readable after a backup.
	_, channelID := a.newServer(admin, "After")
	a.addMessage(channelID, admin, "still works")
}

func TestPruneKeepsNewestScheduledBackups(t *testing.T) {
	backupDir = t.TempDir()
	names := []string{
		"auto-20260101-000000.db", "auto-20260102-000000.db", "auto-20260103-000000.db", "auto-20260104-000000.db",
		"pre-migration-v3-20260101-000000.db", // never pruned
		"notes.txt",
	}
	for _, n := range names {
		if err := os.WriteFile(filepath.Join(backupDir, n), nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	pruneBackups(2)

	var left []string
	entries, _ := os.ReadDir(backupDir)
	for _, e := range entries {
		left = append(left, e.Name())
	}
	want := "auto-20260103-000000.db auto-20260104-000000.db notes.txt pre-migration-v3-20260101-000000.db"
	if got := strings.Join(left, " "); got != want {
		t.Fatalf("left %q, want %q", got, want)
	}
}

func TestBackupSettings(t *testing.T) {
	t.Setenv("BACKUP_INTERVAL", "")
	t.Setenv("BACKUP_KEEP", "")
	if every, keep := backupSettings(); every != 24*time.Hour || keep != 7 {
		t.Errorf("defaults: %v, %d", every, keep)
	}
	t.Setenv("BACKUP_INTERVAL", "6h")
	t.Setenv("BACKUP_KEEP", "30")
	if every, keep := backupSettings(); every != 6*time.Hour || keep != 30 {
		t.Errorf("custom: %v, %d", every, keep)
	}
	for _, off := range []string{"0", "off"} {
		t.Setenv("BACKUP_INTERVAL", off)
		if every, _ := backupSettings(); every != 0 {
			t.Errorf("%q should turn backups off, got %v", off, every)
		}
	}
}

func TestMigrationTakesABackupFirst(t *testing.T) {
	a := newTestApp(t)
	a.login("alice", false)
	// Pretend the database is one migration behind: the next start must copy it before upgrading.
	if _, err := db.Exec(`PRAGMA user_version = ` + itoa(int64(len(migrations)-1))); err != nil {
		t.Fatal(err)
	}
	// The last migration (channel mutes) created its table already; undo that so it can run again.
	if _, err := db.Exec(`DROP TABLE channel_mutes`); err != nil {
		t.Fatal(err)
	}
	migrate()

	files, _ := filepath.Glob(filepath.Join(backupDir, "pre-migration-v"+itoa(int64(len(migrations)-1))+"-*.db"))
	if len(files) != 1 {
		t.Fatalf("pre-migration backups: %v", files)
	}
	var version int
	db.QueryRow(`PRAGMA user_version`).Scan(&version)
	if version != len(migrations) {
		t.Errorf("migrated to %d", version)
	}
}

func TestNoBackupBeforeMigratingANewDatabase(t *testing.T) {
	newTestApp(t)
	if files, _ := filepath.Glob(filepath.Join(backupDir, "pre-migration-*")); len(files) != 0 {
		t.Fatalf("a new, empty database was backed up: %v", files)
	}
}

func TestRunBackupsWaitsOutTheInterval(t *testing.T) {
	newTestApp(t)
	// A backup from a moment ago: nothing new until the interval is up.
	recent := filepath.Join(backupDir, "auto-20260101-000000.db")
	os.MkdirAll(backupDir, 0o700)
	os.WriteFile(recent, nil, 0o600)

	ctx, cancel := contextWithCancel(t)
	done := make(chan struct{})
	go func() { runBackups(ctx, time.Hour, 3); close(done) }()
	time.Sleep(200 * time.Millisecond)
	cancel()
	<-done
	if files := automaticBackups(); len(files) != 1 {
		t.Fatalf("backed up again too soon: %v", files)
	}

	// With no backups at all, the first one is taken right away.
	os.Remove(recent)
	ctx, cancel = contextWithCancel(t)
	done = make(chan struct{})
	go func() { runBackups(ctx, time.Hour, 3); close(done) }()
	deadline := time.Now().Add(5 * time.Second)
	for len(automaticBackups()) == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	<-done
	if len(automaticBackups()) != 1 {
		t.Fatal("no first backup")
	}
}
