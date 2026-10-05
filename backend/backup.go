package main

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// The database is a live SQLite file in WAL mode, so copying it while the server runs can capture a
// half-written state. VACUUM INTO writes a consistent snapshot instead, without stopping anyone.
// Snapshots go in the data folder's backups/ directory; uploads are named by content and never
// change, so a plain copy of uploads/ is enough for them (see DEPLOY.md).

const (
	autoBackupPrefix  = "auto-"
	defaultBackupGap  = 24 * time.Hour
	defaultBackupKeep = 7
)

var backupDir string

// backupDB writes a snapshot named prefix + the time, and returns its path. It's written under a
// temporary name first, so a crash can't leave something that looks like a backup but isn't.
func backupDB(prefix string) (string, error) {
	if err := os.MkdirAll(backupDir, 0o700); err != nil {
		return "", err
	}
	final := filepath.Join(backupDir, prefix+time.Now().UTC().Format("20060102-150405")+".db")
	tmp := final + ".tmp"
	os.Remove(tmp) // VACUUM INTO refuses to overwrite
	if _, err := db.Exec(`VACUUM INTO ?`, tmp); err != nil {
		os.Remove(tmp)
		return "", err
	}
	if err := os.Rename(tmp, final); err != nil {
		os.Remove(tmp)
		return "", err
	}
	return final, nil
}

// automaticBackups lists the scheduled snapshots, oldest first. The time in the name sorts them.
func automaticBackups() []string {
	files, _ := filepath.Glob(filepath.Join(backupDir, autoBackupPrefix+"*.db"))
	sort.Strings(files)
	return files
}

// pruneBackups keeps the newest `keep` scheduled snapshots. Snapshots taken before migrations are
// never removed: they're rare, and they're the way back from a bad upgrade.
func pruneBackups(keep int) {
	files := automaticBackups()
	for len(files) > keep {
		if err := os.Remove(files[0]); err != nil {
			log.Printf("backup: remove %s: %v", files[0], err)
		}
		files = files[1:]
	}
}

// backupSettings reads BACKUP_INTERVAL (a Go duration such as "12h"; "0" or "off" turns scheduled
// backups off) and BACKUP_KEEP.
func backupSettings() (every time.Duration, keep int) {
	every, keep = defaultBackupGap, defaultBackupKeep
	switch v := strings.TrimSpace(os.Getenv("BACKUP_INTERVAL")); v {
	case "":
	case "0", "off":
		every = 0
	default:
		d, err := time.ParseDuration(v)
		if err != nil || d < time.Minute {
			log.Fatalf("BACKUP_INTERVAL must be a duration of at least a minute (such as 12h), or off: %q", v)
		}
		every = d
	}
	if v := os.Getenv("BACKUP_KEEP"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			log.Fatalf("BACKUP_KEEP must be a number, 1 or more: %q", v)
		}
		keep = n
	}
	return every, keep
}

// runBackups takes a snapshot every `every`, the first one after whatever's left of the interval
// since the newest (so restarting doesn't skip a day, or pile up snapshots).
func runBackups(ctx context.Context, every time.Duration, keep int) {
	if every <= 0 {
		log.Print("scheduled backups are off")
		return
	}
	wait := time.Duration(0)
	if files := automaticBackups(); len(files) > 0 {
		if st, err := os.Stat(files[len(files)-1]); err == nil {
			wait = max(0, every-time.Since(st.ModTime()))
		}
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		if path, err := backupDB(autoBackupPrefix); err != nil {
			log.Printf("backup failed: %v", err)
		} else {
			log.Printf("backup written to %s", path)
			pruneBackups(keep)
		}
		wait = every
	}
}
