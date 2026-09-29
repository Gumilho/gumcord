package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
)

// People can set their own name and picture; clearing either goes back to the identity provider's.

const (
	maxProfileName   = 32
	maxAvatarUpload  = 4 << 20
	avatarFormMemory = 1 << 20
)

// handleUpdateProfile sets your display name. An empty name goes back to the identity provider's.
func handleUpdateProfile(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	name := strings.TrimSpace(body.Name)
	if len(name) > maxProfileName {
		http.Error(w, fmt.Sprintf("names can be up to %d characters", maxProfileName), http.StatusBadRequest)
		return
	}
	u := currentUser(r)
	if _, err := db.Exec(`UPDATE users SET custom_name = ? WHERE id = ?`, name, u.ID); err != nil {
		serverError(w, err)
		return
	}
	profileChanged(w, u.ID)
}

// handleSetAvatar takes an uploaded image as your picture.
func handleSetAvatar(w http.ResponseWriter, r *http.Request) {
	url, ok := uploadedFile(w, r, imageKind, "avatar", maxAvatarUpload, "pictures can be up to 4 MB")
	if !ok {
		return
	}
	u := currentUser(r)
	if _, err := db.Exec(`UPDATE users SET custom_avatar = ? WHERE id = ?`, url, u.ID); err != nil {
		serverError(w, err)
		return
	}
	profileChanged(w, u.ID)
}

// handleResetAvatar goes back to the identity provider's picture.
func handleResetAvatar(w http.ResponseWriter, r *http.Request) {
	u := currentUser(r)
	if _, err := db.Exec(`UPDATE users SET custom_avatar = '' WHERE id = ?`, u.ID); err != nil {
		serverError(w, err)
		return
	}
	profileChanged(w, u.ID)
}

// profileChanged answers with the new profile and shows it everywhere: online and member lists,
// and any call the person is in.
func profileChanged(w http.ResponseWriter, id int64) {
	u, err := profile(id)
	if err != nil {
		serverError(w, err)
		return
	}
	hub.updateUser(u)
	notifyServersChanged()
	go updateVoiceProfile(u)
	writeJSON(w, u)
}

// updateVoiceProfile renames the person, and swaps their picture, in the calls they're in.
func updateVoiceProfile(u user) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	updateInCalls(ctx, u.ID, map[string]any{
		"name": u.Name, "attributes": map[string]string{"avatar": u.Avatar}, // "" removes it
	})
}

// updateInCalls changes how someone appears in the calls they're in right now (asked of LiveKit
// directly: the presence snapshot can be a poll behind). Only the server does this; participants
// can't change their own name or attributes.
func updateInCalls(ctx context.Context, userID int64, update map[string]any) {
	channels, err := fetchPresence(ctx)
	if err != nil {
		log.Printf("update %d in calls: %v", userID, err)
		return
	}
	identity := fmt.Sprint(userID)
	for channelID, members := range channels {
		for _, m := range members {
			if m.Identity != identity {
				continue
			}
			room := fmt.Sprintf("channel-%d", channelID)
			req := map[string]any{"room": room, "identity": identity}
			for k, v := range update {
				req[k] = v
			}
			if err := roomService(ctx, "UpdateParticipant", videoGrant{RoomAdmin: true, Room: room}, req, &struct{}{}); err != nil {
				log.Printf("update %s in %s: %v", identity, room, err)
			}
		}
	}
}
