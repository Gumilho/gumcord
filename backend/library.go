package main

import (
	"database/sql"
	"fmt"
	"net/http"
	"strings"
)

// A server's collections of uploads (emotes, soundboard sounds). Every member sees them and can add
// to them; whoever added one, or an admin, can remove it. Changes reach the server's members live.

type library struct {
	table    string // also the WebSocket event that says it changed
	noun     string
	kind     fileKind
	maxSize  int64
	tooLarge string
	maxItems int
	name     func(string) (string, error) // checks and tidies a name
}

type libraryItem struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	URL       string `json:"url"`
	CreatedBy int64  `json:"created_by"`
}

func (l library) create(tx *sql.Tx) error {
	_, err := tx.Exec(`
		CREATE TABLE ` + l.table + ` (
			id         INTEGER PRIMARY KEY,
			server_id  INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
			name       TEXT NOT NULL COLLATE NOCASE, -- "Kappa" and "kappa" are the same
			url        TEXT NOT NULL,
			created_by INTEGER NOT NULL REFERENCES users(id),
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			UNIQUE (server_id, name)
		)`)
	return err
}

// Everyone in the server refetches the list.
func (l library) notify(serverID int64) {
	hub.broadcastTo(map[string]any{"type": l.table, "server_id": serverID}, serverAudience(serverID))
}

func (l library) handleList(w http.ResponseWriter, r *http.Request) {
	id, ok := accessibleServer(w, r)
	if !ok {
		return
	}
	rows, err := db.Query(`SELECT id, name, url, created_by FROM `+l.table+` WHERE server_id = ? ORDER BY lower(name)`, id)
	if err != nil {
		serverError(w, err)
		return
	}
	defer rows.Close()
	items := []libraryItem{}
	for rows.Next() {
		var it libraryItem
		if err := rows.Scan(&it.ID, &it.Name, &it.URL, &it.CreatedBy); err != nil {
			serverError(w, err)
			return
		}
		items = append(items, it)
	}
	writeJSON(w, items)
}

// handleAdd takes a form with the name and the file.
func (l library) handleAdd(w http.ResponseWriter, r *http.Request) {
	id, ok := accessibleServer(w, r)
	if !ok {
		return
	}
	var count int
	if err := db.QueryRow(`SELECT count(*) FROM `+l.table+` WHERE server_id = ?`, id).Scan(&count); err != nil {
		serverError(w, err)
		return
	}
	if count >= l.maxItems {
		http.Error(w, fmt.Sprintf("a server can have up to %d %ss", l.maxItems, l.noun), http.StatusConflict)
		return
	}
	url, ok := uploadedFile(w, r, l.kind, l.noun, l.maxSize, l.tooLarge)
	if !ok {
		return
	}
	name, err := l.name(r.FormValue("name"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	u := currentUser(r)
	it := libraryItem{Name: name, URL: url, CreatedBy: u.ID}
	err = db.QueryRow(`INSERT INTO `+l.table+` (server_id, name, url, created_by) VALUES (?, ?, ?, ?) RETURNING id`, id, name, url, u.ID).Scan(&it.ID)
	if err != nil && strings.Contains(err.Error(), "UNIQUE") {
		http.Error(w, fmt.Sprintf("there's already a %s called %s", l.noun, name), http.StatusConflict)
		return
	} else if err != nil {
		serverError(w, err)
		return
	}
	l.notify(id)
	writeJSON(w, it)
}

func (l library) handleDelete(w http.ResponseWriter, r *http.Request) {
	id, ok := accessibleServer(w, r)
	if !ok {
		return
	}
	itemID, ok := pathID(r, "item")
	var createdBy int64
	if ok {
		ok = db.QueryRow(`SELECT created_by FROM `+l.table+` WHERE id = ? AND server_id = ?`, itemID, id).Scan(&createdBy) == nil
	}
	if !ok {
		http.Error(w, "no such "+l.noun, http.StatusNotFound)
		return
	}
	if u := currentUser(r); u.ID != createdBy && !u.Admin {
		http.Error(w, "only whoever added it, or an admin, can remove it", http.StatusForbidden)
		return
	}
	if _, err := db.Exec(`DELETE FROM `+l.table+` WHERE id = ?`, itemID); err != nil {
		serverError(w, err)
		return
	}
	l.notify(id)
	w.WriteHeader(http.StatusNoContent)
}
