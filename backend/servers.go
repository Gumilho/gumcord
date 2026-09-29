package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Servers group channels. Admins (a PocketID group) see and manage every server; everyone else sees
// the servers an admin has added them to.

type server struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

const maxNameLen = 64

func canAccessServer(u user, serverID int64) bool {
	query, args := `SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?`, []any{serverID, u.ID}
	if u.Admin {
		query, args = `SELECT 1 FROM servers WHERE id = ?`, []any{serverID}
	}
	var one int
	return db.QueryRow(query, args...).Scan(&one) == nil
}

// channelAccess returns a channel's server and kind, and whether u may use it.
func channelAccess(u user, channelID int64) (serverID int64, kind string, ok bool) {
	if db.QueryRow(`SELECT server_id, kind FROM channels WHERE id = ?`, channelID).Scan(&serverID, &kind) != nil {
		return 0, "", false
	}
	return serverID, kind, canAccessServer(u, serverID)
}

// visibleChannels is every channel u can see, for filtering live updates.
func visibleChannels(u user) map[int64]bool {
	query, args := `SELECT c.id FROM channels c JOIN server_members m ON m.server_id = c.server_id WHERE m.user_id = ?`, []any{u.ID}
	if u.Admin {
		query, args = `SELECT id FROM channels`, nil
	}
	out := map[int64]bool{}
	rows, err := db.Query(query, args...)
	if err != nil {
		log.Printf("visible channels: %v", err)
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		rows.Scan(&id)
		out[id] = true
	}
	return out
}

// serverAudience reports which connected users may see a server's live updates.
func serverAudience(serverID int64) func(user) bool {
	members := map[int64]bool{}
	if rows, err := db.Query(`SELECT user_id FROM server_members WHERE server_id = ?`, serverID); err == nil {
		for rows.Next() {
			var id int64
			rows.Scan(&id)
			members[id] = true
		}
		rows.Close()
	}
	return func(u user) bool { return u.Admin || members[u.ID] }
}

// notifyServersChanged tells every client to refetch its servers, channels and members. Each client
// only gets back what it may see; the event itself carries nothing.
func notifyServersChanged() {
	hub.broadcastRaw([]byte(`{"type":"servers"}`))
	presence.invalidate() // who may see which voice channel may have changed too
}

func requireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return requireUser(func(w http.ResponseWriter, r *http.Request) {
		if !currentUser(r).Admin {
			http.Error(w, "admins only", http.StatusForbidden)
			return
		}
		next(w, r)
	})
}

func pathID(r *http.Request, name string) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue(name), 10, 64)
	return id, err == nil
}

// accessibleServer reads the {id} server from the path. Servers the user can't see are "not found",
// so their existence isn't revealed.
func accessibleServer(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, ok := pathID(r, "id")
	if !ok || !canAccessServer(currentUser(r), id) {
		http.Error(w, "no such server", http.StatusNotFound)
		return 0, false
	}
	return id, true
}

// readName decodes {"name": ...} and trims it.
func readName(w http.ResponseWriter, r *http.Request) (string, bool) {
	var body struct {
		Name string `json:"name"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	name := strings.TrimSpace(body.Name)
	if name == "" || len(name) > maxNameLen {
		http.Error(w, fmt.Sprintf("name must be 1-%d characters", maxNameLen), http.StatusBadRequest)
		return "", false
	}
	return name, true
}

// --- servers ---

func handleServers(w http.ResponseWriter, r *http.Request) {
	u := currentUser(r)
	query, args := `SELECT s.id, s.name FROM servers s JOIN server_members m ON m.server_id = s.id WHERE m.user_id = ? ORDER BY s.id`, []any{u.ID}
	if u.Admin {
		query, args = `SELECT id, name FROM servers ORDER BY id`, nil
	}
	rows, err := db.Query(query, args...)
	if err != nil {
		serverError(w, err)
		return
	}
	defer rows.Close()
	out := []server{}
	for rows.Next() {
		var s server
		rows.Scan(&s.ID, &s.Name)
		out = append(out, s)
	}
	writeJSON(w, out)
}

// handleCreateServer makes a server with the usual two channels, with its creator as a member.
func handleCreateServer(w http.ResponseWriter, r *http.Request) {
	name, ok := readName(w, r)
	if !ok {
		return
	}
	tx, err := db.Begin()
	if err != nil {
		serverError(w, err)
		return
	}
	defer tx.Rollback()
	s := server{Name: name}
	if err := tx.QueryRow(`INSERT INTO servers (name) VALUES (?) RETURNING id`, name).Scan(&s.ID); err != nil {
		serverError(w, err)
		return
	}
	// One statement per Exec: with several, the driver binds each statement's parameters from the start.
	if _, err := tx.Exec(`INSERT INTO channels (server_id, name, kind) VALUES (?, 'general', 'text'), (?, 'General', 'voice')`, s.ID, s.ID); err != nil {
		serverError(w, err)
		return
	}
	if _, err := tx.Exec(`INSERT INTO server_members (server_id, user_id) VALUES (?, ?)`, s.ID, currentUser(r).ID); err != nil {
		serverError(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		serverError(w, err)
		return
	}
	notifyServersChanged()
	writeJSON(w, s)
}

func handleRenameServer(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r, "id")
	name, okName := readName(w, r)
	if !ok || !okName {
		return
	}
	res, err := db.Exec(`UPDATE servers SET name = ? WHERE id = ?`, name, id)
	if err != nil {
		serverError(w, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		http.Error(w, "no such server", http.StatusNotFound)
		return
	}
	notifyServersChanged()
	w.WriteHeader(http.StatusNoContent)
}

// handleDeleteServer removes a server with its channels and messages, and ends its voice calls.
func handleDeleteServer(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r, "id")
	if !ok {
		http.Error(w, "no such server", http.StatusNotFound)
		return
	}
	rooms := voiceRooms(id)
	tx, err := db.Begin()
	if err != nil {
		serverError(w, err)
		return
	}
	defer tx.Rollback()
	// Messages don't cascade from channels, so they go first; channels and members cascade from the server.
	if _, err := tx.Exec(`DELETE FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE server_id = ?)`, id); err != nil {
		serverError(w, err)
		return
	}
	res, err := tx.Exec(`DELETE FROM servers WHERE id = ?`, id)
	if err != nil {
		serverError(w, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		http.Error(w, "no such server", http.StatusNotFound)
		return
	}
	if err := tx.Commit(); err != nil {
		serverError(w, err)
		return
	}
	go endVoiceCalls(rooms, "")
	notifyServersChanged()
	w.WriteHeader(http.StatusNoContent)
}

// --- channels ---

func handleServerChannels(w http.ResponseWriter, r *http.Request) {
	id, ok := accessibleServer(w, r)
	if !ok {
		return
	}
	rows, err := db.Query(`SELECT id, server_id, name, kind FROM channels WHERE server_id = ? ORDER BY id`, id)
	if err != nil {
		serverError(w, err)
		return
	}
	defer rows.Close()
	out := []channel{}
	for rows.Next() {
		var c channel
		rows.Scan(&c.ID, &c.ServerID, &c.Name, &c.Kind)
		out = append(out, c)
	}
	writeJSON(w, out)
}

func handleCreateChannel(w http.ResponseWriter, r *http.Request) {
	id, ok := accessibleServer(w, r)
	if !ok {
		return
	}
	var body struct {
		Name string `json:"name"`
		Kind string `json:"kind"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	c := channel{ServerID: id, Name: strings.TrimSpace(body.Name), Kind: body.Kind}
	if c.Name == "" || len(c.Name) > maxNameLen || (c.Kind != "text" && c.Kind != "voice") {
		http.Error(w, "bad channel", http.StatusBadRequest)
		return
	}
	err := db.QueryRow(`INSERT INTO channels (server_id, name, kind) VALUES (?, ?, ?) RETURNING id`, id, c.Name, c.Kind).Scan(&c.ID)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			http.Error(w, "a channel with that name already exists", http.StatusConflict)
			return
		}
		serverError(w, err)
		return
	}
	notifyServersChanged()
	writeJSON(w, c)
}

// --- members ---

func queryUsers(w http.ResponseWriter, query string, args ...any) {
	rows, err := db.Query(query, args...)
	if err != nil {
		serverError(w, err)
		return
	}
	defer rows.Close()
	out := []user{}
	for rows.Next() {
		var u user
		rows.Scan(&u.ID, &u.Name, &u.Avatar, &u.Admin)
		out = append(out, u)
	}
	writeJSON(w, out)
}

func handleServerMembers(w http.ResponseWriter, r *http.Request) {
	id, ok := accessibleServer(w, r)
	if !ok {
		return
	}
	queryUsers(w, `
		SELECT u.id, u.name, u.avatar, u.is_admin FROM users u
		JOIN server_members m ON m.user_id = u.id
		WHERE m.server_id = ? ORDER BY lower(u.name), u.id`, id)
}

// handleUsers lists everyone who has signed in, for admins adding people to servers.
func handleUsers(w http.ResponseWriter, r *http.Request) {
	queryUsers(w, `SELECT id, name, avatar, is_admin FROM users ORDER BY lower(name), id`)
}

func handleAddMember(w http.ResponseWriter, r *http.Request) {
	id, ok1 := pathID(r, "id")
	userID, ok2 := pathID(r, "user")
	if !ok1 || !ok2 {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if _, err := db.Exec(`INSERT OR IGNORE INTO server_members (server_id, user_id) VALUES (?, ?)`, id, userID); err != nil {
		if strings.Contains(err.Error(), "FOREIGN KEY") {
			http.Error(w, "no such server or user", http.StatusNotFound)
			return
		}
		serverError(w, err)
		return
	}
	notifyServersChanged()
	w.WriteHeader(http.StatusNoContent)
}

// handleRemoveMember takes someone out of a server, including any of its voice calls they're in.
func handleRemoveMember(w http.ResponseWriter, r *http.Request) {
	id, ok1 := pathID(r, "id")
	userID, ok2 := pathID(r, "user")
	if !ok1 || !ok2 {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if _, err := db.Exec(`DELETE FROM server_members WHERE server_id = ? AND user_id = ?`, id, userID); err != nil {
		serverError(w, err)
		return
	}
	go endVoiceCalls(voiceRooms(id), strconv.FormatInt(userID, 10))
	notifyServersChanged()
	w.WriteHeader(http.StatusNoContent)
}

// --- voice rooms of a server ---

func voiceRooms(serverID int64) []string {
	var rooms []string
	rows, err := db.Query(`SELECT id FROM channels WHERE server_id = ? AND kind = 'voice'`, serverID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		rows.Scan(&id)
		rooms = append(rooms, fmt.Sprintf("channel-%d", id))
	}
	return rooms
}

// endVoiceCalls disconnects one person from the rooms (identity set), or ends the rooms for
// everyone. A token already handed out is otherwise good until it expires.
func endVoiceCalls(rooms []string, identity string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, room := range rooms {
		var err error
		if identity != "" {
			err = roomService(ctx, "RemoveParticipant", videoGrant{RoomAdmin: true, Room: room},
				map[string]string{"room": room, "identity": identity}, &struct{}{})
		} else {
			err = roomService(ctx, "DeleteRoom", videoGrant{RoomCreate: true}, map[string]string{"room": room}, &struct{}{})
		}
		// Not being in the room (or it not existing) is the usual case, and fine.
		if err != nil && !strings.Contains(err.Error(), "404") {
			log.Printf("end voice call in %s: %v", room, err)
		}
	}
}
