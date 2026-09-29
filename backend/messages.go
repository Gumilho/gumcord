package main

import (
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"
)

// Changing sent messages: people edit and delete their own; admins can delete anyone's.
// Everyone who can see the channel gets the change live.

// messageFor finds a message the user can see (and its server), answering 404 when there's none.
func messageFor(w http.ResponseWriter, r *http.Request) (id, channelID, authorID, serverID int64, ok bool) {
	id, ok = pathID(r, "id")
	if ok {
		ok = db.QueryRow(`SELECT channel_id, user_id FROM messages WHERE id = ?`, id).Scan(&channelID, &authorID) == nil
	}
	if ok {
		serverID, _, ok = channelAccess(currentUser(r), channelID)
	}
	if !ok {
		http.Error(w, "no such message", http.StatusNotFound)
	}
	return
}

func handleEditMessage(w http.ResponseWriter, r *http.Request) {
	id, channelID, authorID, serverID, ok := messageFor(w, r)
	if !ok {
		return
	}
	if authorID != currentUser(r).ID {
		http.Error(w, "you can only edit your own messages", http.StatusForbidden)
		return
	}
	var body struct {
		Content string `json:"content"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if utf8.RuneCountInString(body.Content) > maxMessageLen {
		http.Error(w, fmt.Sprintf("messages can be up to %d characters", maxMessageLen), http.StatusBadRequest)
		return
	}
	var attachment string
	db.QueryRow(`SELECT attachment_url FROM messages WHERE id = ?`, id).Scan(&attachment)
	if strings.TrimSpace(body.Content) == "" && attachment == "" {
		http.Error(w, "a message can't be empty", http.StatusBadRequest)
		return
	}
	var editedAt string
	err := db.QueryRow(`UPDATE messages SET content = ?, edited_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING edited_at`, body.Content, id).Scan(&editedAt)
	if err != nil {
		serverError(w, err)
		return
	}
	hub.broadcastTo(map[string]any{
		"type": "message_edited", "id": id, "channel_id": channelID, "content": body.Content, "edited_at": editedAt,
	}, serverAudience(serverID))
	w.WriteHeader(http.StatusNoContent)
}

func handleDeleteMessage(w http.ResponseWriter, r *http.Request) {
	id, channelID, authorID, serverID, ok := messageFor(w, r)
	if !ok {
		return
	}
	if u := currentUser(r); authorID != u.ID && !u.Admin {
		http.Error(w, "only admins can delete other people's messages", http.StatusForbidden)
		return
	}
	if _, err := db.Exec(`DELETE FROM messages WHERE id = ?`, id); err != nil {
		serverError(w, err)
		return
	}
	hub.broadcastTo(map[string]any{"type": "message_deleted", "id": id, "channel_id": channelID}, serverAudience(serverID))
	w.WriteHeader(http.StatusNoContent)
}
