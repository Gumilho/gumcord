package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/golang-jwt/jwt/v5"
)

var (
	sharedPassword = envOr("SHARED_PASSWORD", "gumcord")
	jwtSecret      = []byte(envOr("JWT_SECRET", "change-me-in-production"))
	lkAPIKey       = envOr("LK_API_KEY", "devkey")
	lkAPISecret    = envOr("LK_API_SECRET", "")
)

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

type ctxKey string

const ctxUsername ctxKey = "username"

func main() {
	initDB()

	mux := http.NewServeMux()
	mux.HandleFunc("POST /login", handleLogin)
	mux.HandleFunc("GET /channels", guard(handleChannels))
	mux.HandleFunc("POST /channels", guard(handleCreateChannel))
	mux.HandleFunc("GET /channels/{id}/messages", guard(handleMessages))
	mux.HandleFunc("GET /ws", guard(handleWS))
	mux.HandleFunc("POST /voice/token", guard(handleVoiceToken))

	log.Println("backend listening on :8080")
	log.Fatal(http.ListenAndServe(":8080", corsMiddleware(mux)))
}

// --- middleware ---

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin == "" {
			origin = "*"
		}
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// guard validates the JWT from Authorization header or ?token= query param.
func guard(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		raw := ""
		if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
			raw = strings.TrimPrefix(h, "Bearer ")
		} else if q := r.URL.Query().Get("token"); q != "" {
			raw = q
		}
		if raw == "" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		claims := &jwt.RegisteredClaims{}
		tok, err := jwt.ParseWithClaims(raw, claims, func(*jwt.Token) (any, error) {
			return jwtSecret, nil
		})
		if err != nil || !tok.Valid {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		ctx := context.WithValue(r.Context(), ctxUsername, claims.Subject)
		next(w, r.WithContext(ctx))
	}
}

// --- handlers ---

func handleLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Username == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if body.Password != sharedPassword {
		http.Error(w, "wrong password", http.StatusUnauthorized)
		return
	}

	if _, err := db.Exec(`INSERT OR IGNORE INTO users (username) VALUES (?)`, body.Username); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.RegisteredClaims{
		Subject:   body.Username,
		IssuedAt:  jwt.NewNumericDate(time.Now()),
		ExpiresAt: jwt.NewNumericDate(time.Now().Add(30 * 24 * time.Hour)),
	})
	signed, err := tok.SignedString(jwtSecret)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"token": signed})
}

func handleChannels(w http.ResponseWriter, r *http.Request) {
	rows, err := db.Query(`SELECT id, name, kind FROM channels ORDER BY id`)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()
	if rows.Err() != nil {
		http.Error(w, "sql error", http.StatusInternalServerError)
		return
	}

	type channel struct {
		ID   int64  `json:"id"`
		Name string `json:"name"`
		Kind string `json:"kind"`
	}
	out := []channel{}
	for rows.Next() {
		var c channel
		rows.Scan(&c.ID, &c.Name, &c.Kind)
		out = append(out, c)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

func handleCreateChannel(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
		Kind string `json:"kind"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Name) == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if body.Kind != "text" && body.Kind != "voice" {
		http.Error(w, "invalid kind", http.StatusBadRequest)
		return
	}

	res, err := db.Exec(`INSERT INTO channels (name, kind) VALUES (?, ?)`, strings.TrimSpace(body.Name), body.Kind)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	id, _ := res.LastInsertId()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"id": id, "name": strings.TrimSpace(body.Name), "kind": body.Kind})
}

func handleMessages(w http.ResponseWriter, r *http.Request) {
	rows, err := db.Query(`
		SELECT m.id, m.content, u.username, m.created_at
		FROM messages m JOIN users u ON m.user_id = u.id
		WHERE m.channel_id = ?
		ORDER BY m.id DESC LIMIT 50
	`, r.PathValue("id"))
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()
	if rows.Err() != nil {
		http.Error(w, "sql error", http.StatusInternalServerError)
		return
	}

	type message struct {
		ID        int64  `json:"id"`
		Content   string `json:"content"`
		Username  string `json:"username"`
		CreatedAt string `json:"created_at"`
	}
	msgs := []message{}
	for rows.Next() {
		var m message
		rows.Scan(&m.ID, &m.Content, &m.Username, &m.CreatedAt)
		msgs = append(msgs, m)
	}

	// reverse to chronological order
	for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
		msgs[i], msgs[j] = msgs[j], msgs[i]
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(msgs)
}

type wsMsg struct {
	ID        int64  `json:"id"`
	ChannelID int64  `json:"channel_id"`
	Username  string `json:"username"`
	Content   string `json:"content"`
	CreatedAt string `json:"created_at"`
}

func handleWS(w http.ResponseWriter, r *http.Request) {
	username := r.Context().Value(ctxUsername).(string)

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		return
	}
	defer conn.CloseNow()

	hub.add(conn, username)
	defer hub.remove(conn)

	var userID int64
	if err := db.QueryRow(`SELECT id FROM users WHERE username = ?`, username).Scan(&userID); err != nil {
		return
	}

	ctx := r.Context()
	for {
		var in struct {
			ChannelID int64  `json:"channel_id"`
			Content   string `json:"content"`
		}
		if err := wsjson.Read(ctx, conn, &in); err != nil {
			break
		}
		if strings.TrimSpace(in.Content) == "" {
			continue
		}

		res, err := db.Exec(
			`INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, ?)`,
			in.ChannelID, userID, in.Content,
		)
		if err != nil {
			log.Printf("insert message: %v", err)
			continue
		}

		id, _ := res.LastInsertId()
		var createdAt string
		db.QueryRow(`SELECT created_at FROM messages WHERE id = ?`, id).Scan(&createdAt)

		hub.broadcast(wsMsg{
			ID:        id,
			ChannelID: in.ChannelID,
			Username:  username,
			Content:   in.Content,
			CreatedAt: createdAt,
		})
	}
}

func handleVoiceToken(w http.ResponseWriter, r *http.Request) {
	username := r.Context().Value(ctxUsername).(string)

	var body struct {
		Room string `json:"room"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.Room == "" {
		body.Room = "voice"
	}

	type videoGrant struct {
		Room     string `json:"room"`
		RoomJoin bool   `json:"roomJoin"`
	}
	type lkClaims struct {
		Video *videoGrant `json:"video"`
		jwt.RegisteredClaims
	}

	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, lkClaims{
		Video:     &videoGrant{Room: body.Room, RoomJoin: true},
		Issuer:    lkAPIKey,
		Subject:   username,
		IssuedAt:  jwt.NewNumericDate(time.Now()),
		ExpiresAt: jwt.NewNumericDate(time.Now().Add(24 * time.Hour)),
	})
	signed, err := tok.SignedString([]byte(lkAPISecret))
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"token": signed})
}
