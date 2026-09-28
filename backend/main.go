package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/golang-jwt/jwt/v5"
)

var (
	lkAPIKey    = mustEnv("LK_API_KEY")
	lkAPISecret = mustEnv("LK_API_SECRET")
	uploadDir   string
)

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("%s must be set", key)
	}
	return v
}

func main() {
	dataDir := envOr("DATA_DIR", "data")
	uploadDir = filepath.Join(dataDir, "uploads")
	if err := os.MkdirAll(uploadDir, 0o755); err != nil {
		log.Fatal(err)
	}
	initDB(dataDir)
	initAuth(dataDir)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/auth/login", handleLogin)
	mux.HandleFunc("GET /api/auth/callback", handleCallback)
	mux.HandleFunc("GET /api/auth/dev", handleDevLogin)
	mux.HandleFunc("POST /api/auth/logout", handleLogout)
	mux.HandleFunc("POST /api/auth/desktop/start", handleDesktopStart)
	mux.HandleFunc("POST /api/auth/desktop/approve", handleDesktopApprove)
	mux.HandleFunc("POST /api/auth/desktop/poll", handleDesktopPoll)
	mux.HandleFunc("GET /api/me", requireUser(handleMe))
	mux.HandleFunc("GET /api/channels", requireUser(handleChannels))
	mux.HandleFunc("POST /api/channels", requireUser(handleCreateChannel))
	mux.HandleFunc("GET /api/channels/{id}/messages", requireUser(handleMessages))
	mux.HandleFunc("GET /api/ws", requireUser(handleWS))
	mux.HandleFunc("POST /api/voice/token", requireUser(handleVoiceToken))
	mux.HandleFunc("POST /api/upload", requireUser(handleUpload))
	mux.HandleFunc("GET /api/", http.NotFound) // keep unknown API paths out of the app fallback
	mux.Handle("GET /files/", serveUploads())
	// In production the backend also serves the built app; in development Vite does.
	if dir := os.Getenv("STATIC_DIR"); dir != "" {
		mux.Handle("GET /", serveApp(dir))
	}

	// Rejects cross-site form posts and fetches, which would otherwise ride the session cookie.
	csrf := http.NewCrossOriginProtection()
	if publicURL != "" {
		if err := csrf.AddTrustedOrigin(publicURL); err != nil {
			log.Fatalf("PUBLIC_URL: %v", err)
		}
	}

	addr := envOr("ADDR", ":8080")
	srv := &http.Server{Addr: addr, Handler: csrf.Handler(mux), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()
	log.Printf("backend listening on %s", addr)

	// Shut down cleanly on stop so SQLite checkpoints its WAL.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	srv.Shutdown(shutdown)
	db.Close()
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

// sameOrigin reports whether a browser request comes from our own pages. CrossOriginProtection
// only covers unsafe methods, and the WebSocket handshake is a GET.
func sameOrigin(r *http.Request) bool {
	switch r.Header.Get("Sec-Fetch-Site") {
	case "same-origin", "none":
		return true
	case "":
		// Engines without Fetch Metadata: compare Origin instead. No Origin means not a browser.
		o := r.Header.Get("Origin")
		if o == "" || o == publicURL {
			return true
		}
		u, err := url.Parse(o)
		return err == nil && u.Host == r.Host
	}
	return false
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
	Author         string `json:"author"`
	Content        string `json:"content"`
	CreatedAt      string `json:"created_at"`
	AttachmentURL  string `json:"attachment_url,omitempty"`
	AttachmentType string `json:"attachment_type,omitempty"`
}

// --- handlers ---

func handleChannels(w http.ResponseWriter, r *http.Request) {
	rows, err := db.Query(`SELECT id, name, kind FROM channels ORDER BY id`)
	if err != nil {
		serverError(w, err)
		return
	}
	defer rows.Close()

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
		SELECT m.id, m.channel_id, u.name, m.content, m.created_at, m.attachment_url, m.attachment_type
		FROM messages m JOIN users u ON m.user_id = u.id
		WHERE m.channel_id = ?
		ORDER BY m.id DESC LIMIT 50
	`, r.PathValue("id"))
	if err != nil {
		serverError(w, err)
		return
	}
	defer rows.Close()

	msgs := []wsMsg{}
	for rows.Next() {
		var m wsMsg
		rows.Scan(&m.ID, &m.ChannelID, &m.Author, &m.Content, &m.CreatedAt, &m.AttachmentURL, &m.AttachmentType)
		msgs = append(msgs, m)
	}

	// reverse to chronological order
	for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
		msgs[i], msgs[j] = msgs[j], msgs[i]
	}

	writeJSON(w, msgs)
}

const wsPingInterval = 25 * time.Second

func handleWS(w http.ResponseWriter, r *http.Request) {
	u := currentUser(r)
	if !sameOrigin(r) {
		http.Error(w, "cross-origin websocket", http.StatusForbidden)
		return
	}

	// Origin is checked above; the library's own check compares against Host, which a proxy may rewrite.
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer conn.CloseNow()

	hub.add(conn)
	defer hub.remove(conn)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	// Keeps idle connections alive through proxies, and notices dead ones.
	go func() {
		t := time.NewTicker(wsPingInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				pingCtx, done := context.WithTimeout(ctx, 10*time.Second)
				err := conn.Ping(pingCtx)
				done()
				if err != nil {
					conn.CloseNow()
					return
				}
			}
		}
	}()

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
			Author:         u.Name,
			Content:        in.Content,
			AttachmentURL:  in.AttachmentURL,
			AttachmentType: in.AttachmentType,
		}
		err := db.QueryRow(
			`INSERT INTO messages (channel_id, user_id, content, attachment_url, attachment_type)
			 VALUES (?, ?, ?, ?, ?) RETURNING id, created_at`,
			in.ChannelID, u.ID, in.Content, in.AttachmentURL, in.AttachmentType,
		).Scan(&msg.ID, &msg.CreatedAt)
		if err != nil {
			log.Printf("insert message: %v", err)
			continue
		}
		hub.broadcast(msg)
	}
}

func handleVoiceToken(w http.ResponseWriter, r *http.Request) {
	u := currentUser(r)

	var body struct {
		ChannelID int64 `json:"channel_id"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	var kind string
	if err := db.QueryRow(`SELECT kind FROM channels WHERE id = ?`, body.ChannelID).Scan(&kind); err != nil || kind != "voice" {
		http.Error(w, "no such voice channel", http.StatusNotFound)
		return
	}

	type videoGrant struct {
		Room     string `json:"room"`
		RoomJoin bool   `json:"roomJoin"`
		// Lets clients publish their own deafen state as a participant attribute.
		CanUpdateOwnMetadata bool `json:"canUpdateOwnMetadata"`
	}
	type lkClaims struct {
		Video *videoGrant `json:"video"`
		Name  string      `json:"name"`
		jwt.RegisteredClaims
	}

	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, lkClaims{
		Video: &videoGrant{Room: fmt.Sprintf("channel-%d", body.ChannelID), RoomJoin: true, CanUpdateOwnMetadata: true},
		// Identity is the stable user ID; the display name can change between logins.
		Name: u.Name,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    lkAPIKey,
			Subject:   strconv.FormatInt(u.ID, 10),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(24 * time.Hour)),
		},
	})
	signed, err := tok.SignedString([]byte(lkAPISecret))
	if err != nil {
		serverError(w, err)
		return
	}

	writeJSON(w, map[string]string{"token": signed})
}

// serveApp serves the built SvelteKit app, falling back to index.html for client-side routes.
func serveApp(dir string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		file := filepath.Join(dir, filepath.FromSlash(path.Clean("/"+r.URL.Path)))
		if st, err := os.Stat(file); err != nil || st.IsDir() {
			file = filepath.Join(dir, "index.html")
		}
		if strings.HasPrefix(r.URL.Path, "/_app/immutable/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache") // index.html must pick up new builds
		}
		http.ServeFile(w, r, file)
	})
}

const maxUploadSize = 25 << 20

// Sniffed image types and the extension they're stored under. Anything else is served as a download.
var imageExts = map[string]string{
	"image/png":  ".png",
	"image/jpeg": ".jpg",
	"image/gif":  ".gif",
	"image/webp": ".webp",
	"image/bmp":  ".bmp",
}

func isImageExt(ext string) bool {
	for _, e := range imageExts {
		if e == ext {
			return true
		}
	}
	return false
}

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

// Uploads are public to anyone with the link, like Discord attachments: names are 96 random bits.
func serveUploads() http.Handler {
	files := http.StripPrefix("/files/", http.FileServer(noDirFS{http.Dir(uploadDir)}))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Upload names are random and never reused, so a file can be cached forever.
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		// Uploaded HTML or SVG opened directly must not run as the app: sandbox it and force a download.
		w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'")
		if !isImageExt(path.Ext(r.URL.Path)) {
			w.Header().Set("Content-Disposition", "attachment")
		}
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

	// Images are stored under the extension of their sniffed type, so a file can't be displayed
	// as an image and served as something else. SVG is never an image here: it can carry scripts.
	kind, ext := "file", safeExt(header.Filename)
	if e, ok := imageExts[mime]; ok {
		kind, ext = "image", e
	}

	name := randHex(12) + ext
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

// safeExt keeps a short alphanumeric extension from the original name, or none.
func safeExt(filename string) string {
	ext := strings.ToLower(filepath.Ext(filename))
	if len(ext) < 2 || len(ext) > 10 {
		return ""
	}
	for _, c := range ext[1:] {
		if (c < 'a' || c > 'z') && (c < '0' || c > '9') {
			return ""
		}
	}
	return ext
}
