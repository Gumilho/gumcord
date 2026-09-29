package main

import (
	"context"
	"encoding/json"
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
	json.NewDecoder(r.Body).Decode(&body)
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

// updateVoiceProfile renames the person, and swaps their picture, in the calls they're in right
// now (asked of LiveKit directly: the presence snapshot can be a poll behind). Their own client does
// this for its call too; this covers their other devices.
func updateVoiceProfile(u user) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	channels, err := fetchPresence(ctx)
	if err != nil {
		log.Printf("update %d in calls: %v", u.ID, err)
		return
	}
	identity := fmt.Sprint(u.ID)
	var rooms []string
	for channelID, members := range channels {
		for _, m := range members {
			if m.Identity == identity {
				rooms = append(rooms, fmt.Sprintf("channel-%d", channelID))
			}
		}
	}
	for _, room := range rooms {
		err := roomService(ctx, "UpdateParticipant", videoGrant{RoomAdmin: true, Room: room}, map[string]any{
			"room": room, "identity": identity, "name": u.Name,
			"attributes": map[string]string{"avatar": u.Avatar}, // "" removes it
		}, &struct{}{})
		if err != nil {
			log.Printf("update %s in %s: %v", identity, room, err)
		}
	}
}
