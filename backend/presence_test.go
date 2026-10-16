package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A LiveKit that has one room, channel-<id>, with one person in it.
func fakeLiveKit(t *testing.T, channel int64) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/ListRooms"):
			json.NewEncoder(w).Encode(map[string]any{"rooms": []map[string]any{{"name": "channel-" + itoa(channel)}}})
		case strings.HasSuffix(r.URL.Path, "/ListParticipants"):
			json.NewEncoder(w).Encode(map[string]any{"participants": []map[string]any{{
				"identity": "7", "name": "carol", "state": "ACTIVE", "joined_at_ms": "1700000000000",
			}}})
		}
	}))
	old := livekitAPIURL
	livekitAPIURL = srv.URL
	t.Cleanup(func() { livekitAPIURL = old; srv.Close() })
}

func TestVoicePresenceReachesANewConnection(t *testing.T) {
	f := newChatFixture(t)
	fakeLiveKit(t, f.voiceChannel)
	ctx, cancel := contextWithCancel(t)
	defer cancel()
	go runPresence(ctx)

	w := f.alice.mustConnect(f.srv)
	ev := w.mustGet(func(ev map[string]any) bool {
		chans, _ := ev["channels"].(map[string]any)
		return ev["type"] == "voice" && len(chans) > 0
	})
	t.Log(ev)
}
