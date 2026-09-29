package main

import (
	"context"
	"net/http"
	"time"
)

// Voice tokens last a few minutes: enough to connect. LiveKit hands connected clients fresh ones,
// so calls go on for as long as they like, but a leaked or kept token soon stops working.
const voiceTokenTTL = 15 * time.Minute

// handleSetDeafened shows (or clears) the deafened mark on you in your calls. The server does it:
// voice tokens don't let participants change their own attributes, or their name.
func handleSetDeafened(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Deafened bool `json:"deafened"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	value := ""
	if body.Deafened {
		value = "1"
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	updateInCalls(ctx, currentUser(r).ID, map[string]any{"attributes": map[string]string{"deafened": value}})
	w.WriteHeader(http.StatusNoContent)
}
