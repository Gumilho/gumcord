package main

import (
	"database/sql"
	"fmt"
	"net/http"
	"regexp"
	"strings"
)

// Custom emotes: each server's own pictures, written :name: in messages. Any member can add one;
// whoever added it, or an admin, can remove it.

const (
	maxEmoteSize      = 512 << 10
	maxEmotesInServer = 200
)

var emoteName = regexp.MustCompile(`^[A-Za-z0-9_]{2,32}$`)

type emote struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	URL       string `json:"url"`
	CreatedBy int64  `json:"created_by"`
}

func migrateEmotes(tx *sql.Tx) error {
	_, err := tx.Exec(`
		CREATE TABLE emotes (
			id         INTEGER PRIMARY KEY,
			server_id  INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
			name       TEXT NOT NULL COLLATE NOCASE, -- :Kappa: and :kappa: are the same emote
			url        TEXT NOT NULL,
			created_by INTEGER NOT NULL REFERENCES users(id),
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			UNIQUE (server_id, name)
		)`)
	return err
}

// Everyone in the server refetches its emotes.
func notifyEmotesChanged(serverID int64) {
	hub.broadcastTo(map[string]any{"type": "emotes", "server_id": serverID}, serverAudience(serverID))
}

func handleServerEmotes(w http.ResponseWriter, r *http.Request) {
	id, ok := accessibleServer(w, r)
	if !ok {
		return
	}
	rows, err := db.Query(`SELECT id, name, url, created_by FROM emotes WHERE server_id = ? ORDER BY lower(name)`, id)
	if err != nil {
		serverError(w, err)
		return
	}
	defer rows.Close()
	emotes := []emote{}
	for rows.Next() {
		var e emote
		if err := rows.Scan(&e.ID, &e.Name, &e.URL, &e.CreatedBy); err != nil {
			serverError(w, err)
			return
		}
		emotes = append(emotes, e)
	}
	writeJSON(w, emotes)
}

// handleAddEmote takes a form with the emote's name and picture.
func handleAddEmote(w http.ResponseWriter, r *http.Request) {
	id, ok := accessibleServer(w, r)
	if !ok {
		return
	}
	var count int
	if err := db.QueryRow(`SELECT count(*) FROM emotes WHERE server_id = ?`, id).Scan(&count); err != nil {
		serverError(w, err)
		return
	}
	if count >= maxEmotesInServer {
		http.Error(w, fmt.Sprintf("a server can have up to %d emotes", maxEmotesInServer), http.StatusConflict)
		return
	}
	url, ok := uploadedImage(w, r, "emote", maxEmoteSize, "emotes can be up to 512 KB")
	if !ok {
		return
	}
	name := strings.TrimSpace(strings.Trim(r.FormValue("name"), ":"))
	if !emoteName.MatchString(name) {
		http.Error(w, "names are 2-32 letters, digits or _", http.StatusBadRequest)
		return
	}
	u := currentUser(r)
	res, err := db.Exec(`INSERT INTO emotes (server_id, name, url, created_by) VALUES (?, ?, ?, ?)`, id, name, url, u.ID)
	if err != nil && strings.Contains(err.Error(), "UNIQUE") {
		http.Error(w, fmt.Sprintf("there's already a :%s:", name), http.StatusConflict)
		return
	} else if err != nil {
		serverError(w, err)
		return
	}
	emoteID, _ := res.LastInsertId()
	notifyEmotesChanged(id)
	writeJSON(w, emote{ID: emoteID, Name: name, URL: url, CreatedBy: u.ID})
}

func handleDeleteEmote(w http.ResponseWriter, r *http.Request) {
	id, ok := accessibleServer(w, r)
	if !ok {
		return
	}
	emoteID, ok := pathID(r, "emote")
	var createdBy int64
	if ok {
		ok = db.QueryRow(`SELECT created_by FROM emotes WHERE id = ? AND server_id = ?`, emoteID, id).Scan(&createdBy) == nil
	}
	if !ok {
		http.Error(w, "no such emote", http.StatusNotFound)
		return
	}
	if u := currentUser(r); u.ID != createdBy && !u.Admin {
		http.Error(w, "only whoever added it, or an admin, can remove it", http.StatusForbidden)
		return
	}
	if _, err := db.Exec(`DELETE FROM emotes WHERE id = ?`, emoteID); err != nil {
		serverError(w, err)
		return
	}
	notifyEmotesChanged(id)
	w.WriteHeader(http.StatusNoContent)
}
