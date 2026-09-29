package main

import (
	"context"
	"encoding/json"
	"log"
	"maps"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	// A client that can't take a message in this long is dropped rather than stalling everyone else.
	wsWriteTimeout = 5 * time.Second
	// How long someone stays listed as online after their last connection closes, so a page reload
	// doesn't flash them offline for everyone.
	offlineGrace = 5 * time.Second
)

// The hub holds every open WebSocket. A user is online while they have at least one.
type wsHub struct {
	mu     sync.Mutex
	conns  map[*websocket.Conn]user
	online map[int64]*onlineUser
}

type onlineUser struct {
	user    user
	conns   int
	offline *time.Timer // pending "gone offline", while in the grace period
}

var hub = &wsHub{conns: map[*websocket.Conn]user{}, online: map[int64]*onlineUser{}}

// Enough for every device someone owns, with tabs to spare.
const maxConnsPerUser = 20

// add registers a connection, unless the user already has too many.
func (h *wsHub) add(conn *websocket.Conn, u user) bool {
	h.mu.Lock()
	if o := h.online[u.ID]; o != nil && o.conns >= maxConnsPerUser {
		h.mu.Unlock()
		return false
	}
	h.conns[conn] = u
	o := h.online[u.ID]
	changed := o == nil || o.user != u // a new user, or a new name or picture since their last login
	if o == nil {
		o = &onlineUser{}
		h.online[u.ID] = o
	}
	if o.offline != nil {
		o.offline.Stop() // back within the grace period: they never went offline
		o.offline = nil
	}
	o.user = u
	o.conns++
	h.mu.Unlock()

	if changed {
		h.broadcastOnline()
	}
	return true
}

func (h *wsHub) remove(conn *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	u, ok := h.conns[conn]
	if !ok {
		return
	}
	delete(h.conns, conn)
	o := h.online[u.ID]
	if o.conns--; o.conns > 0 {
		return
	}
	o.offline = time.AfterFunc(offlineGrace, func() {
		h.mu.Lock()
		gone := o.conns == 0 && h.online[u.ID] == o
		if gone {
			delete(h.online, u.ID)
		}
		h.mu.Unlock()
		if gone {
			h.broadcastOnline()
		}
	})
}

// updateUser takes a changed name or picture into the online list and its connections.
func (h *wsHub) updateUser(u user) {
	h.mu.Lock()
	for c, cu := range h.conns {
		if cu.ID == u.ID {
			h.conns[c] = u
		}
	}
	o := h.online[u.ID]
	if o != nil {
		o.user = u
	}
	h.mu.Unlock()
	if o != nil {
		h.broadcastOnline()
	}
}

// onlineMsgFor lists who u may see online, sorted by name: people who share a server with them.
func (h *wsHub) onlineMsgFor(u user) []byte {
	peers := peersOf(u)
	h.mu.Lock()
	users := make([]user, 0, len(h.online))
	for id, o := range h.online {
		if peers == nil || peers[id] {
			users = append(users, o.user)
		}
	}
	h.mu.Unlock()
	sort.Slice(users, func(i, j int) bool {
		a, b := strings.ToLower(users[i].Name), strings.ToLower(users[j].Name)
		if a != b {
			return a < b
		}
		return users[i].ID < users[j].ID
	})
	data, _ := json.Marshal(struct {
		Type  string `json:"type"` // "online"
		Users []user `json:"users"`
	}{"online", users})
	return data
}

func (h *wsHub) count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.conns)
}

// each calls f for every connection and its user, outside the lock.
func (h *wsHub) each(f func(c *websocket.Conn, u user)) {
	h.mu.Lock()
	conns := maps.Clone(h.conns)
	h.mu.Unlock()
	for c, u := range conns {
		f(c, u)
	}
}

// broadcastTo sends v to the connections whose user allow accepts.
func (h *wsHub) broadcastTo(v any, allow func(user) bool) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	h.each(func(c *websocket.Conn, u user) {
		if allow(u) {
			h.send(c, data)
		}
	})
}

// broadcastOnline sends every connection the people it may see online. Also after membership
// changes, since those change who that is.
func (h *wsHub) broadcastOnline() {
	msgs := map[int64][]byte{}
	h.each(func(c *websocket.Conn, u user) {
		msg, ok := msgs[u.ID]
		if !ok {
			msg = h.onlineMsgFor(u)
			msgs[u.ID] = msg
		}
		h.send(c, msg)
	})
}

// peersOf is who u may see online: the people they share a server with, themselves included.
// Admins see every server, so everyone (nil).
func peersOf(u user) map[int64]bool {
	if u.Admin {
		return nil
	}
	peers := map[int64]bool{u.ID: true}
	rows, err := db.Query(`
		SELECT DISTINCT theirs.user_id FROM server_members mine
		JOIN server_members theirs ON theirs.server_id = mine.server_id
		WHERE mine.user_id = ?`, u.ID)
	if err != nil {
		return peers
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		rows.Scan(&id)
		peers[id] = true
	}
	return peers
}

func (h *wsHub) broadcastRaw(data []byte) {
	h.each(func(c *websocket.Conn, _ user) { h.send(c, data) })
}

func (h *wsHub) send(c *websocket.Conn, data []byte) {
	ctx, cancel := context.WithTimeout(context.Background(), wsWriteTimeout)
	defer cancel()
	if err := c.Write(ctx, websocket.MessageText, data); err != nil {
		log.Printf("websocket send: %v", err)
		c.CloseNow()
	}
}
