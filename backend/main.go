package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
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
	if err := os.MkdirAll(uploadDir, 0o755); err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /login", handleLogin)
	mux.HandleFunc("GET /channels", guard(handleChannels))
	mux.HandleFunc("POST /channels", guard(handleCreateChannel))
	mux.HandleFunc("GET /channels/{id}/messages", guard(handleMessages))
	mux.HandleFunc("GET /ws", guard(handleWS))
	mux.HandleFunc("POST /voice/token", guard(handleVoiceToken))
	mux.HandleFunc("POST /upload", guard(handleUpload))
	mux.Handle("GET /files/", serveUploads())

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

// --- helpers ---

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func serverError(w http.ResponseWriter, err error) {
	log.Printf("server error: %v", err)
	http.Error(w, "server error", http.StatusInternalServerError)
}

type channel struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
	Kind string `json:"kind"`
}

// wsMsg is a chat message as sent to clients, both live over the WebSocket and in history.
type wsMsg struct {
	ID             int64  `json:"id"`
	ChannelID      int64  `json:"channel_id"`
	Username       string `json:"username"`
	Content        string `json:"content"`
	CreatedAt      string `json:"created_at"`
	AttachmentURL  string `json:"attachment_url,omitempty"`
	AttachmentType string `json:"attachment_type,omitempty"`
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
		serverError(w, err)
		return
	}

	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.RegisteredClaims{
		Subject:   body.Username,
		IssuedAt:  jwt.NewNumericDate(time.Now()),
		ExpiresAt: jwt.NewNumericDate(time.Now().Add(30 * 24 * time.Hour)),
	})
	signed, err := tok.SignedString(jwtSecret)
	if err != nil {
		serverError(w, err)
		return
	}

	writeJSON(w, map[string]string{"token": signed})
}

func handleChannels(w http.ResponseWriter, r *http.Request) {
	rows, err := db.Query(`SELECT id, name, kind FROM channels ORDER BY id`)
	if err != nil {
		serverError(w, err)
		return
	}
	defer rows.Close()
	if rows.Err() != nil {
		http.Error(w, "sql error", http.StatusInternalServerError)
		return
	}

	out := []channel{}
	for rows.Next() {
		var c channel
		rows.Scan(&c.ID, &c.Name, &c.Kind)
		out = append(out, c)
	}

	writeJSON(w, out)
}

func handleCreateChannel(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
		Kind string `json:"kind"`
	}
	err := json.NewDecoder(r.Body).Decode(&body)
	c := channel{Name: strings.TrimSpace(body.Name), Kind: body.Kind}
	if err != nil || c.Name == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if c.Kind != "text" && c.Kind != "voice" {
		http.Error(w, "invalid kind", http.StatusBadRequest)
		return
	}

	if err := db.QueryRow(`INSERT INTO channels (name, kind) VALUES (?, ?) RETURNING id`, c.Name, c.Kind).Scan(&c.ID); err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, c)
}

func handleMessages(w http.ResponseWriter, r *http.Request) {
	rows, err := db.Query(`
		SELECT m.id, m.channel_id, u.username, m.content, m.created_at,
		       COALESCE(m.attachment_url, ''), COALESCE(m.attachment_type, '')
		FROM messages m JOIN users u ON m.user_id = u.id
		WHERE m.channel_id = ?
		ORDER BY m.id DESC LIMIT 50
	`, r.PathValue("id"))
	if err != nil {
		serverError(w, err)
		return
	}
	defer rows.Close()
	if rows.Err() != nil {
		http.Error(w, "sql error", http.StatusInternalServerError)
		return
	}

	msgs := []wsMsg{}
	for rows.Next() {
		var m wsMsg
		rows.Scan(&m.ID, &m.ChannelID, &m.Username, &m.Content, &m.CreatedAt, &m.AttachmentURL, &m.AttachmentType)
		msgs = append(msgs, m)
	}

	// reverse to chronological order
	for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
		msgs[i], msgs[j] = msgs[j], msgs[i]
	}

	writeJSON(w, msgs)
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
			ChannelID      int64  `json:"channel_id"`
			Content        string `json:"content"`
			AttachmentURL  string `json:"attachment_url"`
			AttachmentType string `json:"attachment_type"`
		}
		if err := wsjson.Read(ctx, conn, &in); err != nil {
			break
		}
		// Only accept attachments that point at our own upload store.
		if !strings.HasPrefix(in.AttachmentURL, "/files/") || strings.Contains(in.AttachmentURL, "..") {
			in.AttachmentURL, in.AttachmentType = "", ""
		}
		if in.AttachmentType != "image" && in.AttachmentURL != "" {
			in.AttachmentType = "file"
		}
		if strings.TrimSpace(in.Content) == "" && in.AttachmentURL == "" {
			continue
		}

		msg := wsMsg{
			ChannelID:      in.ChannelID,
			Username:       username,
			Content:        in.Content,
			AttachmentURL:  in.AttachmentURL,
			AttachmentType: in.AttachmentType,
		}
		err := db.QueryRow(
			`INSERT INTO messages (channel_id, user_id, content, attachment_url, attachment_type)
			 VALUES (?, ?, ?, ?, ?) RETURNING id, created_at`,
			in.ChannelID, userID, in.Content, in.AttachmentURL, in.AttachmentType,
		).Scan(&msg.ID, &msg.CreatedAt)
		if err != nil {
			log.Printf("insert message: %v", err)
			continue
		}
		hub.broadcast(msg)
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
		// Lets clients publish their own deafen state as a participant attribute.
		CanUpdateOwnMetadata bool `json:"canUpdateOwnMetadata"`
	}
	type lkClaims struct {
		Video *videoGrant `json:"video"`
		jwt.RegisteredClaims
	}

	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, lkClaims{
		Video:     &videoGrant{Room: body.Room, RoomJoin: true, CanUpdateOwnMetadata: true},
		Issuer:    lkAPIKey,
		Subject:   username,
		IssuedAt:  jwt.NewNumericDate(time.Now()),
		ExpiresAt: jwt.NewNumericDate(time.Now().Add(24 * time.Hour)),
	})
	signed, err := tok.SignedString([]byte(lkAPISecret))
	if err != nil {
		serverError(w, err)
		return
	}

	writeJSON(w, map[string]string{"token": signed})
}

const (
	uploadDir     = "uploads"
	maxUploadSize = 25 << 20
)

// noDirFS disables directory listings on the file server.
type noDirFS struct{ http.FileSystem }

func (fs noDirFS) Open(name string) (http.File, error) {
	f, err := fs.FileSystem.Open(name)
	if err != nil {
		return nil, err
	}
	if st, err := f.Stat(); err != nil || st.IsDir() {
		f.Close()
		return nil, os.ErrNotExist
	}
	return f, nil
}

func serveUploads() http.Handler {
	files := http.StripPrefix("/files/", http.FileServer(noDirFS{http.Dir(uploadDir)}))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Upload names are random and never reused, so a file can be cached forever.
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		files.ServeHTTP(w, r)
	})
}

// Multipart parts beyond this spill to temp files instead of sitting in memory.
const uploadMemory = 1 << 20

func handleUpload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadSize)
	if err := r.ParseMultipartForm(uploadMemory); err != nil {
		http.Error(w, "file missing or too large", http.StatusRequestEntityTooLarge)
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "file missing or too large", http.StatusRequestEntityTooLarge)
		return
	}
	defer file.Close()

	head := make([]byte, 512)
	n, _ := io.ReadFull(file, head)
	mime := http.DetectContentType(head[:n])
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		serverError(w, err)
		return
	}

	// SVG is deliberately not treated as an image: it can carry scripts.
	kind := "file"
	if strings.HasPrefix(mime, "image/") {
		kind = "image"
	}

	rnd := make([]byte, 12)
	rand.Read(rnd)
	name := hex.EncodeToString(rnd) + strings.ToLower(filepath.Ext(header.Filename))

	dst, err := os.Create(filepath.Join(uploadDir, name))
	if err != nil {
		serverError(w, err)
		return
	}
	defer dst.Close()
	if _, err := io.Copy(dst, file); err != nil {
		os.Remove(dst.Name())
		serverError(w, err)
		return
	}

	writeJSON(w, map[string]string{
		"url":  "/files/" + name,
		"type": kind,
		"name": header.Filename,
	})
}
