package main

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// A client that can't take a message in this long is dropped rather than stalling everyone else.
const wsWriteTimeout = 5 * time.Second

type wsHub struct {
	mu    sync.Mutex
	conns map[*websocket.Conn]struct{}
}

var hub = &wsHub{conns: make(map[*websocket.Conn]struct{})}

func (h *wsHub) add(conn *websocket.Conn) {
	h.mu.Lock()
	h.conns[conn] = struct{}{}
	h.mu.Unlock()
}

func (h *wsHub) remove(conn *websocket.Conn) {
	h.mu.Lock()
	delete(h.conns, conn)
	h.mu.Unlock()
}

func (h *wsHub) count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.conns)
}

func (h *wsHub) broadcast(v any) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	h.broadcastRaw(data)
}

func (h *wsHub) broadcastRaw(data []byte) {
	h.mu.Lock()
	conns := make([]*websocket.Conn, 0, len(h.conns))
	for c := range h.conns {
		conns = append(conns, c)
	}
	h.mu.Unlock()

	for _, c := range conns {
		h.send(c, data)
	}
}

func (h *wsHub) send(c *websocket.Conn, data []byte) {
	ctx, cancel := context.WithTimeout(context.Background(), wsWriteTimeout)
	defer cancel()
	if err := c.Write(ctx, websocket.MessageText, data); err != nil {
		log.Printf("websocket send: %v", err)
		c.CloseNow()
	}
}
