package main

import "net/http"

// Channels someone has muted: new messages there make no sound for them. It only affects their own
// clients; nobody else is told.

func handleChannelMutes(w http.ResponseWriter, r *http.Request) {
	rows, err := db.Query(`SELECT channel_id FROM channel_mutes WHERE user_id = ?`, currentUser(r).ID)
	if err != nil {
		serverError(w, err)
		return
	}
	defer rows.Close()

	ids := []int64{}
	for rows.Next() {
		var id int64
		rows.Scan(&id)
		ids = append(ids, id)
	}
	writeJSON(w, ids)
}

// PUT mutes the {id} channel and DELETE unmutes it. Channels the user can't see are "not found".
func handleSetChannelMute(w http.ResponseWriter, r *http.Request) {
	u := currentUser(r)
	id, ok := pathID(r, "id")
	if ok {
		_, _, ok = channelAccess(u, id)
	}
	if !ok {
		http.Error(w, "no such channel", http.StatusNotFound)
		return
	}

	var err error
	if r.Method == http.MethodPut {
		_, err = db.Exec(`INSERT INTO channel_mutes (user_id, channel_id) VALUES (?, ?) ON CONFLICT DO NOTHING`, u.ID, id)
	} else {
		_, err = db.Exec(`DELETE FROM channel_mutes WHERE user_id = ? AND channel_id = ?`, u.ID, id)
	}
	if err != nil {
		serverError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
