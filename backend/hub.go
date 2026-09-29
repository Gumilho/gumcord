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

func (h *wsHub) add(conn *websocket.Conn, u user) {
	h.mu.Lock()
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
		h.broadcastRaw(h.onlineMsg())
	}
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
			h.broadcastRaw(h.onlineMsg())
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
		h.broadcastRaw(h.onlineMsg())
	}
}

// onlineMsg lists everyone online, sorted by name.
func (h *wsHub) onlineMsg() []byte {
	h.mu.Lock()
	users := make([]user, 0, len(h.online))
	for _, o := range h.online {
		users = append(users, o.user)
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
