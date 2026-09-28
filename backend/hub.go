package main

import (
	"context"
	"encoding/json"
	"log"
	"sync"

	"github.com/coder/websocket"
)

type wsHub struct {
	mu    sync.Mutex
	conns map[*websocket.Conn]string // conn → username
}

var hub = &wsHub{conns: make(map[*websocket.Conn]string)}

func (h *wsHub) add(conn *websocket.Conn, username string) {
	h.mu.Lock()
	h.conns[conn] = username
	h.mu.Unlock()
}

func (h *wsHub) remove(conn *websocket.Conn) {
	h.mu.Lock()
	delete(h.conns, conn)
	h.mu.Unlock()
}

func (h *wsHub) broadcast(v any) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}

	h.mu.Lock()
	conns := make([]*websocket.Conn, 0, len(h.conns))
	for c := range h.conns {
		conns = append(conns, c)
	}
	h.mu.Unlock()

	for _, c := range conns {
		if err := c.Write(context.Background(), websocket.MessageText, data); err != nil {
			log.Printf("broadcast: %v", err)
		}
	}
}
