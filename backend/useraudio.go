package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

// Per-user voice settings: how loud one user hears another, or whether they've muted them.
// They only affect the listener's own client; the other person isn't told.

const maxUserVolume = 2.0 // 200%, like Discord

type userAudio struct {
	TargetID int64   `json:"target_id"`
	Volume   float64 `json:"volume"`
	Muted    bool    `json:"muted"`
}

func handleUserAudio(w http.ResponseWriter, r *http.Request) {
	rows, err := db.Query(`SELECT target_id, volume, muted FROM user_audio WHERE user_id = ?`, currentUser(r).ID)
	if err != nil {
		serverError(w, err)
		return
	}
	defer rows.Close()

	out := []userAudio{}
	for rows.Next() {
		var a userAudio
		rows.Scan(&a.TargetID, &a.Volume, &a.Muted)
		out = append(out, a)
	}
	writeJSON(w, out)
}

func handleSetUserAudio(w http.ResponseWriter, r *http.Request) {
	u := currentUser(r)
	target, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || target == u.ID {
		http.Error(w, "bad target", http.StatusBadRequest)
		return
	}
	var body struct {
		Volume float64 `json:"volume"`
		Muted  bool    `json:"muted"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Volume < 0 || body.Volume > maxUserVolume {
		http.Error(w, "volume must be 0 to 2", http.StatusBadRequest)
		return
	}

	if body.Volume == 1 && !body.Muted {
		_, err = db.Exec(`DELETE FROM user_audio WHERE user_id = ? AND target_id = ?`, u.ID, target)
	} else {
		_, err = db.Exec(`
			INSERT INTO user_audio (user_id, target_id, volume, muted) VALUES (?, ?, ?, ?)
			ON CONFLICT(user_id, target_id) DO UPDATE SET volume = excluded.volume, muted = excluded.muted`,
			u.ID, target, body.Volume, body.Muted)
	}
	if err != nil {
		if strings.Contains(err.Error(), "FOREIGN KEY") {
			http.Error(w, "no such user", http.StatusNotFound)
			return
		}
		serverError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
