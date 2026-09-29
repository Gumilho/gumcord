package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/golang-jwt/jwt/v5"
)

// --- access tokens, for clients joining a room and for the backend's own room API calls ---

type videoGrant struct {
	Room       string `json:"room,omitempty"`
	RoomJoin   bool   `json:"roomJoin,omitempty"`
	RoomList   bool   `json:"roomList,omitempty"`
	RoomAdmin  bool   `json:"roomAdmin,omitempty"`
	RoomCreate bool   `json:"roomCreate,omitempty"` // also allows deleting rooms
	// What a participant may send; none of this lets them change their own name or attributes.
	CanPublishSources []string `json:"canPublishSources,omitempty"`
}

type lkClaims struct {
	Video *videoGrant `json:"video"`
	Name  string      `json:"name,omitempty"`
	// Lets the other clients in the call show this user's picture.
	Attributes map[string]string `json:"attributes,omitempty"`
	jwt.RegisteredClaims
}

func signLiveKit(c lkClaims, ttl time.Duration) (string, error) {
	now := time.Now()
	c.Issuer = lkAPIKey
	c.IssuedAt = jwt.NewNumericDate(now)
	c.ExpiresAt = jwt.NewNumericDate(now.Add(ttl))
	return jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString([]byte(lkAPISecret))
}

// --- room API ---

// The server-side API LiveKit serves on its HTTP port. In Docker, LiveKit is on the host network.
var (
	livekitAPIURL = strings.TrimRight(envOr("LIVEKIT_API_URL", "http://127.0.0.1:7880"), "/")
	livekitClient = &http.Client{Timeout: 5 * time.Second}
)

func roomService(ctx context.Context, method string, grant videoGrant, body, out any) error {
	tok, err := signLiveKit(lkClaims{Video: &grant}, time.Minute)
	if err != nil {
		return err
	}
	payload, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, livekitAPIURL+"/twirp/livekit.RoomService/"+method, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/json")
	res, err := livekitClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: %s", method, res.Status)
	}
	return json.NewDecoder(res.Body).Decode(out)
}

// --- voice presence ---

// Who is in each voice channel, so people outside a call can see it. The backend polls LiveKit while
// anyone has the app open and pushes changes over the chat WebSocket.

const presencePollInterval = 2 * time.Second

type voiceMember struct {
	Identity  string `json:"identity"`
	Name      string `json:"name"`
	Avatar    string `json:"avatar"`
	Muted     bool   `json:"muted"`
	Deafened  bool   `json:"deafened"`
	Streaming bool   `json:"streaming"`
}

type presenceMsg struct {
	Type     string                  `json:"type"` // "voice"
	Channels map[int64][]voiceMember `json:"channels"`
}

type presenceState struct {
	mu       sync.Mutex
	channels map[int64][]voiceMember // the latest poll; nil when there isn't one
	last     []byte                  // the latest poll serialized, to spot changes
	wake     chan struct{}           // polls right away
}

var presence = &presenceState{wake: make(chan struct{}, 1)}

func (p *presenceState) poke() {
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

// snapshotFor returns what u may see of the latest poll, or nil (and asks for a poll) if there's none.
func (p *presenceState) snapshotFor(u user) []byte {
	p.mu.Lock()
	channels := p.channels
	p.mu.Unlock()
	if channels == nil {
		p.poke()
		return nil
	}
	return presenceFor(u, channels)
}

// invalidate resends everyone's view on the next poll, which it starts now: used when who may see
// which channel changes.
func (p *presenceState) invalidate() {
	p.mu.Lock()
	p.last = nil
	p.mu.Unlock()
	p.poke()
}

// presenceFor keeps only the voice channels in u's servers.
func presenceFor(u user, channels map[int64][]voiceMember) []byte {
	visible := visibleChannels(u)
	mine := map[int64][]voiceMember{}
	for id, members := range channels {
		if visible[id] {
			mine[id] = members
		}
	}
	data, _ := json.Marshal(presenceMsg{Type: "voice", Channels: mine})
	return data
}

func runPresence(ctx context.Context) {
	t := time.NewTicker(presencePollInterval)
	defer t.Stop()
	failing := false
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-presence.wake:
		}
		// Nobody is looking: stop polling, and drop the snapshot so it can't be stale later.
		if hub.count() == 0 {
			presence.mu.Lock()
			presence.channels, presence.last = nil, nil
			presence.mu.Unlock()
			continue
		}

		channels, err := fetchPresence(ctx)
		if err != nil {
			if !failing {
				log.Printf("voice presence: %v", err)
			}
			failing = true
			continue
		}
		if failing {
			log.Printf("voice presence: LiveKit reachable again")
			failing = false
		}

		data, _ := json.Marshal(channels)
		presence.mu.Lock()
		changed := !bytes.Equal(data, presence.last)
		presence.channels, presence.last = channels, data
		presence.mu.Unlock()
		if changed {
			// Each user only hears about their own servers' channels; tabs of one user share the work.
			byUser := map[int64][]byte{}
			hub.each(func(c *websocket.Conn, u user) {
				msg, ok := byUser[u.ID]
				if !ok {
					msg = presenceFor(u, channels)
					byUser[u.ID] = msg
				}
				hub.send(c, msg)
			})
		}
	}
}

type lkParticipant struct {
	Identity   string            `json:"identity"`
	Name       string            `json:"name"`
	State      string            `json:"state"`
	JoinedAtMs string            `json:"joined_at_ms"` // an int64, which protobuf JSON writes as a string
	Attributes map[string]string `json:"attributes"`
	Permission struct {
		Hidden bool `json:"hidden"`
	} `json:"permission"`
	Tracks []struct {
		Source string `json:"source"`
		Muted  bool   `json:"muted"`
	} `json:"tracks"`
}

func fetchPresence(ctx context.Context) (map[int64][]voiceMember, error) {
	var rooms struct {
		Rooms []struct {
			Name string `json:"name"`
		} `json:"rooms"`
	}
	if err := roomService(ctx, "ListRooms", videoGrant{RoomList: true}, struct{}{}, &rooms); err != nil {
		return nil, err
	}

	out := map[int64][]voiceMember{}
	for _, room := range rooms.Rooms {
		idStr, ok := strings.CutPrefix(room.Name, "channel-")
		id, err := strconv.ParseInt(idStr, 10, 64)
		// The room list's participant count lags joins by several seconds, so every room is asked directly.
		if !ok || err != nil {
			continue
		}
		var res struct {
			Participants []lkParticipant `json:"participants"`
		}
		// Listing participants needs admin rights for that specific room.
		if err := roomService(ctx, "ListParticipants", videoGrant{RoomAdmin: true, Room: room.Name}, map[string]string{"room": room.Name}, &res); err != nil {
			return nil, err
		}
		sort.SliceStable(res.Participants, func(i, j int) bool {
			a, _ := strconv.ParseInt(res.Participants[i].JoinedAtMs, 10, 64)
			b, _ := strconv.ParseInt(res.Participants[j].JoinedAtMs, 10, 64)
			return a < b
		})

		var members []voiceMember
		for _, p := range res.Participants {
			if p.State == "DISCONNECTED" || p.Permission.Hidden {
				continue
			}
			// Same as the call itself: no published microphone counts as muted.
			m := voiceMember{Identity: p.Identity, Name: p.Name, Avatar: p.Attributes["avatar"], Muted: true, Deafened: p.Attributes["deafened"] == "1"}
			for _, t := range p.Tracks {
				switch t.Source {
				case "MICROPHONE":
					m.Muted = t.Muted
				case "SCREEN_SHARE":
					m.Streaming = true
				}
			}
			members = append(members, m)
		}
		if len(members) > 0 {
			out[id] = members
		}
	}
	return out, nil
}
